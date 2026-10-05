import { EventEmitter } from 'events';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { GroupChat, MessageWithReactions, GroupCreateResult } from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    executablePath?: string;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

/**
 * Compile-time typings for the slice of WhatsApp's injected `WPP` library this adapter uses.
 *
 * WPP is injected by the WhatsApp web client at runtime and ships no type definitions, so
 * every call site used `(window as unknown as { WPP?: WppApi }).WPP`. That made the result of each call an `any`,
 * which pushed `no-unsafe-member-access` errors onto every property read downstream (117 of
 * them) and silently tolerated misspelled or renamed fields.
 *
 * These interfaces are erased at compile time: the cast `(window as unknown as { WPP?: WppApi })`
 * emits nothing, so each `page.evaluate` callback still runs entirely inside the browser and
 * references no module scope.
 */
interface WppStatusEntry {
  id?: string;
  contact?: { id?: string; name?: string; pushname?: string };
  type?: string;
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  /** WPP reports seconds; the string form is tolerated because it comes from the DOM. */
  timestamp?: number | string;
}

interface WppCatalog {
  id?: string;
  name?: string;
  description?: string;
  productCount?: number;
  url?: string;
}

interface WppProduct {
  id?: string;
  name?: string;
  description?: string;
  price?: number | string;
  currency?: string;
  priceFormatted?: string;
  imageUrl?: string;
  url?: string;
  isAvailable?: boolean;
  retailerId?: string;
}

/** WPP send calls return either an object carrying an id or a bare id string. */
type WppSendResult = { id?: string } | string | null;

interface WppCatalogApi {
  getCatalog?: () => WppCatalog | null;
  getProducts?: (opts: { page: number; limit: number }) => {
    products?: WppProduct[];
    pagination?: { page?: number; limit?: number; total?: number; totalPages?: number };
  } | null;
  getProductById?: (id: string) => WppProduct | null;
  sendProduct?: (chatId: string, productId: string, body: string) => WppSendResult;
  sendCatalog?: (chatId: string, body: string) => WppSendResult;
}

interface WppApi {
  status?: {
    list?: (opts: { me: boolean; contactId?: string }) => WppStatusEntry[];
    postTextStatus?: (opts: { text: string; backgroundColor: string; font?: number }) => WppSendResult;
    postImageStatus?: (opts: { image: string; mimetype: string; caption: string }) => WppSendResult;
    postVideoStatus?: (opts: { video: string; mimetype: string; caption: string }) => WppSendResult;
  };
  business?: {
    catalog?: WppCatalogApi;
  };
}

/**
 * Convert a raw WPP status entry into our `Status` shape.
 *
 * `expiresAt` was previously computed as `Number(s.timestamp + 86400)`. Because WPP reports
 * the timestamp as either a number or a string, a string timestamp silently concatenated
 * (`"1735689600" + 86400` -> `"173568960086400"`) and produced an expiry date thousands of
 * years in the future; a missing timestamp produced `NaN` -> an Invalid Date. Normalize to
 * numeric seconds once, then do the arithmetic in numbers.
 */
function wppStatusToStatus(s: WppStatusEntry): Status {
  const seconds = Number(s.timestamp);
  const ts = Number.isFinite(seconds) ? seconds : 0;
  return {
    id: String(s.id || ''),
    contact: {
      id: String(s.contact?.id || ''),
      name: s.contact?.name || undefined,
      pushName: s.contact?.pushname || undefined,
    },
    type: String(s.type || 'text') as 'text' | 'image' | 'video',
    caption: s.caption ? String(s.caption) : undefined,
    mediaUrl: s.mediaUrl ? String(s.mediaUrl) : undefined,
    backgroundColor: s.backgroundColor ? String(s.backgroundColor) : undefined,
    font: Number.isFinite(s.font) ? Number(s.font) : undefined,
    timestamp: new Date(ts * 1000),
    expiresAt: new Date((ts + 86400) * 1000),
  };
}

/**
 * Normalize an id out of a WPP send result.
 *
 * WPP is inconsistent here: some calls return `{ id }`, others return a bare id string and
 * some return null. `result?.id || result || fallback` was the previous behaviour, but it
 * only compiled because the result was `any`; it also stringified `[object Object]` if WPP
 * ever returned an object without an id.
 */
function wppResultId(result: WppSendResult, fallback: string = ''): string {
  if (typeof result === 'string') {
    return result || fallback;
  }
  if (result && typeof result === 'object' && result.id) {
    return String(result.id);
  }
  return fallback;
}

/**
 * The shape `getChannelMessages` actually reads off a channel.
 *
 * This deliberately does not intersect the library's `Channel`: `whatsapp-web.js` types
 * `fetchMessages` as returning `Message[]`, and `Message` has no `mediaUrl` field, so the
 * old `chat as unknown as Channel` + `(chat as any).fetchMessages` combination only compiled
 * because of the `any`. The adapter already casts through `unknown` here, so declare exactly
 * the fields it reads and keep the compiler honest about them.
 */
interface ChannelWithFetch {
  isChannel: boolean;
  fetchMessages?: (opts: { limit: number }) => Promise<
    Array<{
      id: { _serialized?: string; id?: string } | string;
      body?: string;
      timestamp?: number | string;
      hasMedia?: boolean;
      mediaUrl?: string;
    }>
  >;
}

/**
 * Build a clearly-labelled synthetic id for a send whose real WhatsApp id is missing.
 *
 * The previous value was `wa_undefined_${Date.now()}`. That literal `undefined` was easy to
 * mistake for a real id in logs and got persisted into the `messages.waMessageId` column, so
 * replies, deletions and webhook consumers silently referenced a bogus id. Observed on a
 * real send to 201020211605@c.us where `sendMessage()` delivered the message but resolved
 * with no response object.
 *
 * `noid` is a marker, not a value to parse. Callers that need a real id should re-read the
 * chat history; that reconciliation already happened for the message above, but only because
 * the `messages` row was matched on chat + timestamp rather than on this id.
 */
function syntheticWaId(reason: 'no_response' | 'no_serialized'): string {
  return `wa_noid_${reason}_${Date.now()}`;
}

/**
 * Normalize the id off a sent `Message`.
 *
 * `msg.id._serialized` is typed `string` by whatsapp-web.js but is not guaranteed at
 * runtime, and returning it unchecked would put a real `undefined` into a `string` field.
 */
function sentMessageId(msg: { id?: { _serialized?: string } } | undefined | null): string {
  const serialized = msg?.id?._serialized;
  if (typeof serialized === 'string' && serialized.length > 0) {
    return serialized;
  }
  return syntheticWaId(msg ? 'no_serialized' : 'no_response');
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--remote-debugging-port=0',
      ];

      // Ensure --remote-debugging-port is present (needed for scraper to connect)
      if (!puppeteerArgs.some(a => a.startsWith('--remote-debugging-port'))) {
        puppeteerArgs.push('--remote-debugging-port=0');
      }

      // Add proxy configuration if provided
      if (this.config.proxy) {
        let proxyUrl = this.config.proxy.url;
        // Ensure the proxy URL has a protocol prefix for Chromium
        if (!/^https?:\/\//i.test(proxyUrl) && !/^socks[45]:\/\//i.test(proxyUrl)) {
          const typeMap: Record<string, string> = {
            http: 'http',
            https: 'https',
            socks4: 'socks4',
            socks5: 'socks5',
          };
          proxyUrl = `${typeMap[this.config.proxy.type] || 'http'}://${proxyUrl}`;
        }
        puppeteerArgs.push(`--proxy-server=${proxyUrl}`);
        this.logger.log(`Using proxy: ${proxyUrl.replace(/:[^:@]*@/, ':***@')}`);
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          executablePath: this.config.puppeteer?.executablePath,
          args: puppeteerArgs,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      // A failed initialize() can leave a half-launched Chromium plus its LocalAuth
      // session behind. Nothing else holds a reference to it, so it would survive for
      // the whole process lifetime. Tear it down before rethrowing.
      await this.teardownClient();
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage: IncomingMessage = {
          id: msg.id._serialized,
          from: msg.from,
          to: msg.to,
          chatId: msg.from,
          body: msg.body,
          type: msg.type,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          isGroup: msg.from.endsWith('@g.us'),
        };

        // Handle media
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            // String(error) alone is useless here: whatsapp-web.js ships minified, so a thrown
            // error surfaces as "r: r" and nothing about the failure can be recovered from
            // the log. Record the structural fields too, so the next occurrence is
            // diagnosable rather than a dead end. The message is still delivered -- only the
            // media attachment is lost -- so this must not rethrow and drop the message.
            const detail =
              error && typeof error === 'object'
                ? {
                    name: (error as Error).name,
                    message: (error as Error).message,
                    code: (error as { code?: unknown }).code,
                    statusCode: (error as { statusCode?: unknown }).statusCode,
                  }
                : { message: String(error) };

            this.logger.error('Error downloading media', (error as Error)?.stack ?? String(error), {
              action: 'media_download_failed',
              sessionId: this.config.sessionId,
              remoteJid: msg.from,
              msgId: msg.id?._serialized,
              msgType: msg.type,
              hasMedia: msg.hasMedia,
              ...detail,
            });
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  /**
   * Detaches listeners from the current client, closes its browser and drops the
   * reference. Never rejects: every teardown path (init failure, disconnect, logout,
   * destroy, shutdown) funnels through here so a wedged browser cannot propagate an
   * exception into a shutdown loop or a session deletion.
   */
  private async teardownClient(): Promise<void> {
    const client = this.client;
    this.client = null;

    if (!client) return;

    try {
      // Drop listeners first so late events from a dying browser cannot re-enter
      // callbacks that reference this adapter (and everything it captured).
      client.removeAllListeners();
    } catch (error) {
      this.logger.warn('Failed to remove client listeners:', String(error));
    }

    try {
      await client.destroy();
    } catch (error) {
      this.logger.warn('Client destroy failed during teardown:', String(error));
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      // Use destroy instead of logout to preserve session data.
      // This allows reconnecting without needing to scan QR again.
      await this.teardownClient();
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      const client = this.client;
      try {
        // Logout clears session data - user will need to scan QR again
        await client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
      } finally {
        // Always tear the browser down, whether or not logout() succeeded.
        await this.teardownClient();
        this.setStatus(EngineStatus.DISCONNECTED);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.teardownClient();
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const msg = await this.client!.sendMessage(chatId, text);
    if (!msg) {
      this.logger.warn(
        `sendMessage returned undefined (chatId=${chatId}, text="${text.slice(0, 60)}") — message likely delivered but no response object`,
        'sendTextMessage_undefined',
      );
    }
    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      caption: media.caption,
    });

    if (!msg) {
      this.logger.warn(
        `sendMessage (media) returned undefined (chatId=${chatId}) — message likely delivered but no response object`,
        'sendMediaMessage_undefined',
      );
    }

    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
      };
    });
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.client!.sendMessage(chatId, loc);
    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.client!.sendMessage(chatId, vcard, {
      parseVCards: true,
    });
    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return {
      id: sentMessageId(msg),
      timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    try {
      const labels = await this.client!.getLabels();
      if (!labels) {
        return [];
      }
      return labels.map(label => ({
        id: String(label.id),
        name: String(label.name),
        hexColor: String(label.hexColor),
      }));
    } catch (error) {
      this.logger.warn('getLabels failed (requires WhatsApp Business account)', String(error));
      return [];
    }
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    try {
      const label = await this.client!.getLabelById(labelId);
      if (!label) {
        return null;
      }
      return {
        id: String(label.id),
        name: String(label.name),
        hexColor: String(label.hexColor),
      };
    } catch (error) {
      this.logger.warn(`Failed to get label: ${labelId}`, String(error));
      return null;
    }
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      const labels = await chat.getLabels();
      if (!labels) {
        return [];
      }
      return labels.map(label => ({
        id: String(label.id),
        name: String(label.name),
        hexColor: String(label.hexColor),
      }));
    } catch (error) {
      this.logger.warn(`Failed to get labels for chat ${chatId}`, String(error));
      return [];
    }
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      // Get current labels and append the new one
      const currentLabels = await chat.getLabels();
      const currentIds = currentLabels.map(l => String(l.id));
      if (!currentIds.includes(labelId)) {
        currentIds.push(labelId);
      }
      await chat.changeLabels(currentIds);
      this.logger.log(`Added label ${labelId} to chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to add label ${labelId} to chat ${chatId}`, String(error));
      throw new Error(`Failed to add label: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      // Get current labels and remove the specified one
      const currentLabels = await chat.getLabels();
      const remainingIds = currentLabels.filter(l => String(l.id) !== labelId).map(l => l.id);
      await chat.changeLabels(remainingIds);
      this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
    } catch (error) {
      this.logger.error(`Failed to remove label ${labelId} from chat ${chatId}`, String(error));
      throw new Error(`Failed to remove label: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    try {
      const channels = await this.client!.getChannels();
      if (!channels) {
        return [];
      }
      return channels.map(ch => ({
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
      }));
    } catch (error) {
      this.logger.warn('getSubscribedChannels failed', String(error));
      return [];
    }
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(channelId);
      const ch = chat as unknown as import('whatsapp-web.js').Channel;
      // Only return if it's actually a channel
      if (!ch.isChannel) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    try {
      // First resolve invite code to a channel, then subscribe
      const channel = await this.client!.getChannelByInviteCode(inviteCode);
      const channelId = typeof channel.id === 'object' ? channel.id._serialized : channel.id;
      const success = await this.client!.subscribeToChannel(channelId);
      if (!success) {
        throw new Error('Failed to subscribe to channel');
      }
      this.logger.log(`Subscribed to channel via invite code: ${inviteCode}`);
      return {
        id: String(channelId),
        name: String(channel.name || ''),
        description: channel.description ? String(channel.description) : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to subscribe to channel: ${inviteCode}`, String(error));
      throw new Error(`Failed to subscribe: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    try {
      await this.client!.unsubscribeFromChannel(channelId);
      this.logger.log(`Unsubscribed from channel: ${channelId}`);
    } catch (error) {
      this.logger.error(`Failed to unsubscribe from channel: ${channelId}`, String(error));
      throw new Error(`Failed to unsubscribe: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(channelId);
      const ch = chat as unknown as ChannelWithFetch;
      if (!ch.isChannel) {
        throw new Error(`${channelId} is not a channel`);
      }
      const messages = ch.fetchMessages ? await ch.fetchMessages({ limit }) : [];
      if (!messages || !Array.isArray(messages)) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? (msg.id._serialized ?? msg.id.id) : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========

  private get page(): import('puppeteer').Page | null {
    return (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage || null;
  }

  // `evaluateWPP(script, ...args)` used to live here. It built a function out of a string
  // with `new Function`, which is `no-implied-eval` for a good reason: any string reaching
  // it becomes executable code in the page. It had no callers, so it was removed rather
  // than suppressed; every call site below passes a real function to `page.evaluate`.

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        this.logger.warn('Puppeteer page not available for getContactStatuses');
        return [];
      }
      const statuses = await page.evaluate(() => {
        const WPP = (window as unknown as { WPP?: WppApi }).WPP;
        if (!WPP?.status?.list) return [];
        return WPP.status.list({ me: false });
      });
      if (!Array.isArray(statuses)) return [];
      return statuses.map(wppStatusToStatus);
    } catch (error) {
      this.logger.warn('getContactStatuses failed', String(error));
      return [];
    }
  }

  async getContactStatus(contactId: string): Promise<Status[]> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        this.logger.warn('Puppeteer page not available for getContactStatus');
        return [];
      }
      const statuses = await page.evaluate((cid: string) => {
        const WPP = (window as unknown as { WPP?: WppApi }).WPP;
        if (!WPP?.status?.list) return [];
        return WPP.status.list({ me: false, contactId: cid });
      }, contactId);
      if (!Array.isArray(statuses)) return [];
      return statuses.map(wppStatusToStatus);
    } catch (error) {
      this.logger.warn(`getContactStatus(${contactId}) failed`, String(error));
      return [];
    }
  }

  async postTextStatus(text: string, options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        throw new Error('Puppeteer page not available for posting status');
      }
      const result = await page.evaluate(
        (t: string, bg: string | undefined, f: number | undefined) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.status?.postTextStatus) {
            throw new Error('WPP.status.postTextStatus not available');
          }
          return WPP.status.postTextStatus({
            text: t,
            backgroundColor: bg || '#000000',
            font: f ?? 0,
          });
        },
        text,
        options?.backgroundColor,
        options?.font,
      );
      const now = Math.floor(Date.now() / 1000);
      return {
        statusId: wppResultId(result),
        timestamp: new Date(),
        expiresAt: new Date((now + 86400) * 1000),
      };
    } catch (error) {
      this.logger.error('postTextStatus failed', String(error));
      throw new Error(`Failed to post text status: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async postImageStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        throw new Error('Puppeteer page not available for posting status');
      }
      const mediaData =
        typeof media.data === 'string' && (media.data.startsWith('http://') || media.data.startsWith('https://'))
          ? await MessageMedia.fromUrl(media.data)
          : new MessageMedia(
              media.mimetype || 'image/jpeg',
              typeof media.data === 'string' ? media.data : media.data.toString('base64'),
            );
      const result = await page.evaluate(
        (m: { mimetype: string; data: string }, cap: string | undefined) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.status?.postImageStatus) {
            throw new Error('WPP.status.postImageStatus not available');
          }
          return WPP.status.postImageStatus({
            image: m.data,
            mimetype: m.mimetype,
            caption: cap || '',
          });
        },
        { mimetype: mediaData.mimetype, data: mediaData.data },
        caption,
      );
      const now = Math.floor(Date.now() / 1000);
      return {
        statusId: wppResultId(result),
        timestamp: new Date(),
        expiresAt: new Date((now + 86400) * 1000),
      };
    } catch (error) {
      this.logger.error('postImageStatus failed', String(error));
      throw new Error(`Failed to post image status: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async postVideoStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        throw new Error('Puppeteer page not available for posting status');
      }
      const mediaData =
        typeof media.data === 'string' && (media.data.startsWith('http://') || media.data.startsWith('https://'))
          ? await MessageMedia.fromUrl(media.data)
          : new MessageMedia(
              media.mimetype || 'video/mp4',
              typeof media.data === 'string' ? media.data : media.data.toString('base64'),
            );
      const result = await page.evaluate(
        (m: { mimetype: string; data: string }, cap: string | undefined) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.status?.postVideoStatus) {
            throw new Error('WPP.status.postVideoStatus not available');
          }
          return WPP.status.postVideoStatus({
            video: m.data,
            mimetype: m.mimetype,
            caption: cap || '',
          });
        },
        { mimetype: mediaData.mimetype, data: mediaData.data },
        caption,
      );
      const now = Math.floor(Date.now() / 1000);
      return {
        statusId: wppResultId(result),
        timestamp: new Date(),
        expiresAt: new Date((now + 86400) * 1000),
      };
    } catch (error) {
      this.logger.error('postVideoStatus failed', String(error));
      throw new Error(`Failed to post video status: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async deleteStatus(statusId: string): Promise<void> {
    this.ensureReady();
    try {
      await this.client!.revokeStatusMessage(statusId);
      this.logger.log(`Deleted/revoked status: ${statusId}`);
    } catch (error) {
      this.logger.error(`Failed to delete status: ${statusId}`, String(error));
      throw new Error(`Failed to delete status: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        this.logger.warn('Puppeteer page not available for getCatalog');
        return null;
      }
      const catalog = await page.evaluate(() => {
        const WPP = (window as unknown as { WPP?: WppApi }).WPP;
        if (!WPP?.business?.catalog?.getCatalog) return null;
        return WPP.business.catalog.getCatalog();
      });
      if (!catalog) return null;
      return {
        id: String(catalog.id || ''),
        name: String(catalog.name || ''),
        description: catalog.description ? String(catalog.description) : undefined,
        productCount: Number.isFinite(catalog.productCount) ? Number(catalog.productCount) : 0,
        url: String(catalog.url || ''),
      };
    } catch (error) {
      this.logger.warn('getCatalog failed', String(error));
      return null;
    }
  }

  async getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        this.logger.warn('Puppeteer page not available for getProducts');
        return { products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
      }
      const result = await page.evaluate(
        (opts: { page?: number; limit?: number }) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.business?.catalog?.getProducts) return null;
          return WPP.business.catalog.getProducts({ page: opts.page || 1, limit: opts.limit || 20 });
        },
        { page: options?.page || 1, limit: options?.limit || 20 },
      );
      if (!result) {
        return { products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
      }
      const products: Product[] = (result.products || []).map((p: WppProduct) => ({
        id: String(p.id || ''),
        name: String(p.name || ''),
        description: p.description ? String(p.description) : undefined,
        price: Number(p.price) || 0,
        currency: String(p.currency || 'USD'),
        priceFormatted: String(p.priceFormatted || `$${Number(p.price).toFixed(2)}`),
        imageUrl: p.imageUrl ? String(p.imageUrl) : undefined,
        url: String(p.url || ''),
        isAvailable: p.isAvailable !== false,
        retailerId: p.retailerId ? String(p.retailerId) : undefined,
      }));
      return {
        products,
        pagination: {
          page: Number(result.pagination?.page) || 1,
          limit: Number(result.pagination?.limit) || 20,
          total: Number(result.pagination?.total) || products.length,
          totalPages: Number(result.pagination?.totalPages) || 1,
        },
      };
    } catch (error) {
      this.logger.warn('getProducts failed', String(error));
      return { products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    }
  }

  async getProduct(productId: string): Promise<Product | null> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        this.logger.warn('Puppeteer page not available for getProduct');
        return null;
      }
      const product = await page.evaluate((pid: string) => {
        const WPP = (window as unknown as { WPP?: WppApi }).WPP;
        if (!WPP?.business?.catalog?.getProductById) return null;
        return WPP.business.catalog.getProductById(pid);
      }, productId);
      if (!product) return null;
      return {
        id: String(product.id || ''),
        name: String(product.name || ''),
        description: product.description ? String(product.description) : undefined,
        price: Number(product.price) || 0,
        currency: String(product.currency || 'USD'),
        priceFormatted: String(product.priceFormatted || `$${Number(product.price).toFixed(2)}`),
        imageUrl: product.imageUrl ? String(product.imageUrl) : undefined,
        url: String(product.url || ''),
        isAvailable: product.isAvailable !== false,
        retailerId: product.retailerId ? String(product.retailerId) : undefined,
      };
    } catch (error) {
      this.logger.warn(`getProduct(${productId}) failed`, String(error));
      return null;
    }
  }

  async sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        throw new Error('Puppeteer page not available for sending product');
      }
      const result = await page.evaluate(
        (cId: string, pId: string, b: string | undefined) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.business?.catalog?.sendProduct) {
            throw new Error('WPP.business.catalog.sendProduct not available');
          }
          return WPP.business.catalog.sendProduct(cId, pId, b || '');
        },
        chatId,
        productId,
        body,
      );
      return {
        id: wppResultId(result, `product_${productId}_${Date.now()}`),
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      this.logger.error('sendProduct failed', String(error));
      throw new Error(`Failed to send product: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async sendCatalog(chatId: string, body?: string): Promise<MessageResult> {
    this.ensureReady();
    try {
      const page = this.page;
      if (!page) {
        throw new Error('Puppeteer page not available for sending catalog');
      }
      const result = await page.evaluate(
        (cId: string, b: string | undefined) => {
          const WPP = (window as unknown as { WPP?: WppApi }).WPP;
          if (!WPP?.business?.catalog?.sendCatalog) {
            throw new Error('WPP.business.catalog.sendCatalog not available');
          }
          return WPP.business.catalog.sendCatalog(cId, b || '');
        },
        chatId,
        body,
      );
      return {
        id: wppResultId(result, `catalog_${Date.now()}`),
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      this.logger.error('sendCatalog failed', String(error));
      throw new Error(`Failed to send catalog: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
