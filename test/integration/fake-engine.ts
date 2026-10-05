import {
  EngineEventCallbacks,
  EngineStatus,
  IWhatsAppEngine,
  IncomingMessage,
} from '../../src/engine/interfaces/whatsapp-engine.interface';

/**
 * An in-process stand-in for the real WhatsApp engine.
 *
 * The integration suite drives the *real* Nest application — real repositories, real
 * SQLite, real SessionService, real WebhookService — and only swaps the browser driver
 * for this fake. That is the closest hermetic equivalent to a live WhatsApp session: every
 * code path between "engine emitted an event" and "row landed in the database" runs
 * unchanged, including the crash-prone paths we care about (network loss, DB failure).
 *
 * Methods the lifecycle touches are implemented for real; anything else resolves to a
 * benign default so tests that wander into unrelated APIs do not explode.
 */
export class FakeEngine implements IWhatsAppEngine {
  readonly sessionId: string;
  private callbacks: EngineEventCallbacks = {};
  private status: EngineStatus = EngineStatus.INITIALIZING;
  private qr: string | null = null;
  private phone: string | null = null;
  private pushName: string | null = null;
  private destroyed = false;
  private disconnects = 0;
  private initializations = 0;

  /** Set by a test to make the next lifecycle call fail, simulating a broken driver. */
  failNextInitialize: Error | null = null;
  failNextDisconnect: Error | null = null;
  failNextDestroy: Error | null = null;

  /**
   * When set, `initialize()` emits this QR *before* resolving, the way whatsapp-web.js does.
   *
   * The real driver fires `qr` while the browser is still booting, so the callback lands
   * before `initialize()`'s promise settles. Reproducing that ordering is what makes the
   * session-service state machine testable at all: a fake that only emits the QR after
   * `initialize()` hides every bug caused by work that happens "too late" relative to it.
   */
  qrDuringInitialize: string | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // ── Test controls ────────────────────────────────────────────────

  get callCounts(): { initialize: number; disconnect: number; destroy: number } {
    return { initialize: this.initializations, disconnect: this.disconnects, destroy: this.destroyed ? 1 : 0 };
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Emits a QR exactly like whatsapp-web.js does. */
  emitQRCode(qr: string): void {
    this.qr = qr;
    this.status = EngineStatus.QR_READY;
    this.callbacks.onQRCode?.(qr);
  }

  /** Emits the authenticated-ready event. */
  emitReady(phone: string, pushName: string): void {
    this.phone = phone;
    this.pushName = pushName;
    this.status = EngineStatus.READY;
    this.callbacks.onReady?.(phone, pushName);
  }

  emitMessage(message: Partial<IncomingMessage> & { id: string }): void {
    const full: IncomingMessage = {
      body: '',
      timestamp: Date.now(),
      from: '628123456789@c.us',
      chatId: '628123456789@c.us',
      isGroup: false,
      hasMedia: false,
      ...message,
    } as IncomingMessage;
    this.callbacks.onMessage?.(full);
  }

  /** Simulates the socket dropping, which is what triggers a reconnect. */
  emitDisconnected(reason = 'connection lost'): void {
    this.status = EngineStatus.DISCONNECTED;
    this.callbacks.onDisconnected?.(reason);
  }

  // ── IWhatsAppEngine lifecycle ───────────────────────────────────

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.initializations++;
    this.callbacks = callbacks;
    if (this.failNextInitialize) {
      const err = this.failNextInitialize;
      this.failNextInitialize = null;
      throw err;
    }
    if (this.qrDuringInitialize) {
      // Synchronously, like the driver's own 'qr' listener.
      this.emitQRCode(this.qrDuringInitialize);
      this.qrDuringInitialize = null;
    }
    this.status = EngineStatus.QR_READY;
  }

  async disconnect(): Promise<void> {
    this.disconnects++;
    if (this.failNextDisconnect) {
      const err = this.failNextDisconnect;
      this.failNextDisconnect = null;
      throw err;
    }
    this.status = EngineStatus.DISCONNECTED;
  }

  async logout(): Promise<void> {
    this.status = EngineStatus.DISCONNECTED;
  }

  async destroy(): Promise<void> {
    if (this.failNextDestroy) {
      const err = this.failNextDestroy;
      this.failNextDestroy = null;
      throw err;
    }
    this.destroyed = true;
    this.callbacks = {};
  }

  getStatus(): EngineStatus {
    return this.status;
  }
  getQRCode(): string | null {
    return this.qr;
  }
  getPhoneNumber(): string | null {
    return this.phone;
  }
  getPushName(): string | null {
    return this.pushName;
  }
  async sendTextMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendImageMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendVideoMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendAudioMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendDocumentMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendLocationMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendContactMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendStickerMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async replyToMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async forwardMessage(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async reactToMessage(): Promise<void> {
    /* no-op */
  }
  async getMessageReactions(): Promise<never[]> {
    return [];
  }
  async getContacts(): Promise<never[]> {
    return [];
  }
  async getContactById(): Promise<null> {
    return null;
  }
  async checkNumberExists(): Promise<boolean> {
    return true;
  }
  async getGroups(): Promise<never[]> {
    return [];
  }
  async getGroupInfo(): Promise<null> {
    return null;
  }
  async createGroup(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async addParticipants(): Promise<void> {
    /* no-op */
  }
  async removeParticipants(): Promise<void> {
    /* no-op */
  }
  async promoteParticipants(): Promise<void> {
    /* no-op */
  }
  async demoteParticipants(): Promise<void> {
    /* no-op */
  }
  async leaveGroup(): Promise<void> {
    /* no-op */
  }
  async setGroupSubject(): Promise<void> {
    /* no-op */
  }
  async setGroupDescription(): Promise<void> {
    /* no-op */
  }
  async getGroupInviteCode(): Promise<string> {
    return 'INVITE';
  }
  async revokeGroupInviteCode(): Promise<string> {
    // The interface returns the *new* invite code; returning `void` here was a mismatch
    // that only `implements IWhatsAppEngine` exposed.
    return 'INVOKE_REVOKED';
  }
  async deleteMessage(): Promise<void> {
    /* no-op */
  }
  async getProfilePicture(): Promise<null> {
    return null;
  }
  async blockContact(): Promise<void> {
    /* no-op */
  }
  async unblockContact(): Promise<void> {
    /* no-op */
  }
  async getLabels(): Promise<never[]> {
    return [];
  }
  async getLabelById(): Promise<null> {
    return null;
  }
  async getChatLabels(): Promise<never[]> {
    return [];
  }
  async addLabelToChat(): Promise<void> {
    /* no-op */
  }
  async removeLabelFromChat(): Promise<void> {
    /* no-op */
  }
  async getSubscribedChannels(): Promise<never[]> {
    return [];
  }
  async getChannelById(): Promise<null> {
    return null;
  }
  async subscribeToChannel(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async unsubscribeFromChannel(): Promise<void> {
    /* no-op */
  }
  async getChannelMessages(): Promise<never[]> {
    return [];
  }
  async getContactStatuses(): Promise<never[]> {
    return [];
  }
  async getContactStatus(): Promise<never[]> {
    return [];
  }
  async postTextStatus(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async postImageStatus(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async postVideoStatus(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async deleteStatus(): Promise<void> {
    /* no-op */
  }
  async getCatalog(): Promise<null> {
    return null;
  }
  async getProducts(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async getProduct(): Promise<null> {
    return null;
  }
  async sendProduct(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
  async sendCatalog(): Promise<never> {
    throw new Error('not implemented in FakeEngine');
  }
}
