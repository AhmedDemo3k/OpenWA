import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { IWhatsAppEngine, EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { KeyedMutex } from '../../common/utils/keyed-mutex.util';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
  /**
   * Timestamp of the last time this session reached READY. Used as a flapping guard:
   * a session that connects and drops within `flapWindowMs` must NOT get its attempt
   * counter reset, otherwise `maxAttempts` is unreachable and the session reconnects
   * forever on a fixed short delay.
   */
  lastReadyAt: number | null;
  /**
   * Consecutive reconnects that produced a *stable* session, tracked across flap windows
   * so a permanently unstable session eventually stops burning CPU and Chromium memory.
   */
  flappingCount: number;
}

/** Disconnect reasons after which reconnecting cannot possibly help. */
const TERMINAL_DISCONNECT_PATTERNS: readonly RegExp[] = [
  /log[\s_-]?out/i,
  /unauthori[sz]ed/i,
  /auth/i,
  /ban/i,
  /block/i,
  /del/i,
  /invalid[\s_-]?qr/i,
];

/** A session that drops within this window after becoming ready is treated as flapping. */
const FLAP_WINDOW_MS = 60_000;

/** After this many consecutive flaps, stop auto-reconnecting and require operator action. */
const MAX_CONSECUTIVE_FLAPS = 3;

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Serialises start/stop/delete/reconnect per session id
  private readonly locks = new KeyedMutex();

  /**
   * Wall-clock budget for tearing down every engine on shutdown. Chromium teardown can
   * take seconds per session; without a cap, enough sessions push total shutdown past the
   * orchestrator's grace period and the container is SIGKILLed mid-cleanup.
   */
  private static readonly SHUTDOWN_BUDGET_MS = 15_000;

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
    ];

    // Captured BEFORE the reset below. Asking afterwards would always come back empty,
    // because the reset is precisely what clears these statuses.
    let resumable: Session[] = [];
    try {
      resumable = await this.sessionRepository.find({
        where: { status: In([SessionStatus.READY, SessionStatus.INITIALIZING]) },
      });
    } catch (error) {
      // A failure here only costs us the autostart convenience; the reset still has to run.
      this.logger.error('Could not read sessions for autostart', String(error), {
        action: 'startup_resume_read_failed',
      });
    }

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }

    await this.resumeSessionsAfterRestart(resumable);
  }

  /**
   * Bring back the sessions that were live when the process went down.
   *
   * The reset in `onModuleInit` is deliberate: the engines are gone, so a persisted status
   * of READY would be a lie. But leaving them at DISCONNECTED means a restart silently takes
   * the instance offline, and this one is fronted by a public endpoint -- so a host reboot or
   * the watchdog recovering a wedged process all looked like an outage even though the
   * WhatsApp credentials on disk were still perfectly valid.
   *
   * Only sessions that were actually mid-flight are resumed, so one the operator had
   * deliberately stopped stays stopped. Failures are logged and swallowed: a session that
   * cannot come back must not stop the API from serving traffic.
   */
  private async resumeSessionsAfterRestart(resumable: Session[]): Promise<void> {
    if (resumable.length === 0) {
      return;
    }

    if (process.env.SESSION_AUTOSTART === 'false') {
      this.logger.log('Session autostart disabled by SESSION_AUTOSTART=false', {
        action: 'startup_resume_skipped',
        sessions: resumable.map(s => s.name),
      });
      return;
    }

    this.logger.log(`Resuming ${resumable.length} session(s) that were live before restart`, {
      action: 'startup_resume',
      sessions: resumable.map(s => s.name),
    });

    for (const session of resumable) {
      try {
        await this.start(session.id);
        this.logger.log(`Resumed session ${session.name}`, {
          action: 'startup_resume_ok',
          sessionId: session.id,
        });
      } catch (error) {
        this.logger.error(`Could not resume session ${session.name} on startup`, String(error), {
          action: 'startup_resume_failed',
          sessionId: session.id,
        });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Stop reconnect timers FIRST so nothing re-creates an engine while we tear down.
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.reconnectStates.clear();

    // Let any in-flight start()/stop()/reconnect() finish so it cannot install a new
    // engine after the snapshot below.
    await this.locks.drain();

    const deadline = Date.now() + SessionService.SHUTDOWN_BUDGET_MS;
    const engines = Array.from(this.engines.entries());
    this.engines.clear();

    for (const [sessionId, engine] of engines) {
      const remaining = Math.max(0, deadline - Date.now());
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      try {
        // One slow or throwing engine must not strand the remaining browsers.
        await Promise.race([
          engine.destroy(),
          new Promise<void>(resolve => {
            const t = setTimeout(resolve, remaining);
            if (typeof t.unref === 'function') t.unref();
          }),
        ]);
      } catch (error: unknown) {
        this.logger.error(
          `Failed to destroy engine for session ${sessionId}`,
          error instanceof Error ? error.message : String(error),
          { sessionId, action: 'shutdown_error' },
        );
      }
    }
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    this.safely('webhook:session.created', saved.id, () =>
      this.webhookService.dispatch(saved.id, 'session.created', { id: saved.id, name: saved.name }),
    );

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    await this.locks.withLock(id, async () => {
      const session = await this.findOne(id);

      // Cancel any reconnection attempts
      this.cancelReconnect(id);

      // Stop engine if running
      const engine = this.engines.get(id);
      if (engine) {
        // Tear the browser down before dropping the reference, otherwise a throwing
        // destroy() would leak a Chromium process that nothing can reach.
        await this.destroyEngineQuietly(engine, id, 'delete');
        this.engines.delete(id);
      }

      // Execute hook BEFORE delete so plugins can access session data
      await this.hookManager.execute(
        'session:deleted',
        {
          id: session.id,
          name: session.name,
          phone: session.phone,
          pushName: session.pushName,
        },
        {
          sessionId: id,
          source: 'SessionService',
        },
      );

      // Dispatch before the row (and its webhooks) are removed so subscribers receive it.
      this.safely('webhook:session.deleted', id, () =>
        this.webhookService.dispatch(id, 'session.deleted', {
          id: session.id,
          name: session.name,
          phone: session.phone,
        }),
      );

      await this.dataSource.transaction(async manager => {
        await manager.remove(session);
      });
      this.logger.log(`Session deleted: ${session.name}`, {
        sessionId: id,
        action: 'delete',
      });
    });
  }

  async start(id: string): Promise<Session> {
    // Serialised per session: two concurrent start() calls would otherwise both pass the
    // `engines.has()` check and race to create engines, orphaning the first browser.
    return this.locks.withLock(id, async () => {
      const session = await this.findOne(id);

      if (this.engines.has(id)) {
        throw new BadRequestException('Session is already started');
      }

      // Execute hook before starting
      await this.hookManager.execute(
        'session:starting',
        { sessionId: id },
        {
          sessionId: id,
          source: 'SessionService',
        },
      );

      // Initialize reconnect state
      const config = session.config as {
        maxReconnectAttempts?: number;
        reconnectBaseDelay?: number;
      } | null;
      this.reconnectStates.set(id, {
        attempts: 0,
        timer: null,
        maxAttempts: config?.maxReconnectAttempts ?? 5,
        baseDelay: config?.reconnectBaseDelay ?? 5000,
        lastReadyAt: null,
        flappingCount: 0,
      });

      await this.initializeEngine(id, session);
      return this.findOne(id);
    });
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });

    try {
      await engine.initialize({
        onQRCode: (): void => {
          this.logger.log('QR code generated', {
            sessionId: id,
            action: 'qr_generated',
          });

          // Execute hook for QR event
          this.safely('hook:session:qr', id, () =>
            this.hookManager.execute(
              'session:qr',
              { sessionId: id },
              {
                sessionId: id,
                source: 'Engine',
              },
            ),
          );

          this.safely('status:qr_ready', id, () => this.updateStatus(id, SessionStatus.QR_READY));
        },
        onReady: (phone: string, pushName: string): void => {
          this.logger.log(`Session ready: ${phone}`, {
            sessionId: id,
            phone,
            pushName,
            action: 'ready',
          });

          // Execute hook for ready event
          this.safely('hook:session:ready', id, () =>
            this.hookManager.execute(
              'session:ready',
              { phone, pushName },
              {
                sessionId: id,
                source: 'Engine',
              },
            ),
          );

          // Reset reconnect attempts, but only if this session was actually stable.
          // Unconditionally zeroing the counter makes `maxAttempts` unreachable for a
          // session that keeps dropping seconds after connecting, which turns it into an
          // endless reconnect loop that spawns a fresh Chromium on every cycle.
          const reconnectState = this.reconnectStates.get(id);
          if (reconnectState) {
            const now = Date.now();
            const wasFlapping =
              reconnectState.lastReadyAt !== null && now - reconnectState.lastReadyAt < FLAP_WINDOW_MS;

            if (wasFlapping) {
              reconnectState.flappingCount++;
              this.logger.warn(
                `Session ${session.name} reconnected but dropped within ${FLAP_WINDOW_MS / 1000}s ` +
                  `(${reconnectState.flappingCount}/${MAX_CONSECUTIVE_FLAPS})`,
                { sessionId: id, action: 'reconnect_flapping' },
              );
            } else {
              reconnectState.flappingCount = 0;
              reconnectState.attempts = 0;
            }
            reconnectState.lastReadyAt = now;
          }

          this.safely('status:ready', id, () =>
            this.sessionRepository.update(id, {
              status: SessionStatus.READY,
              phone,
              pushName,
              connectedAt: new Date(),
              lastActiveAt: new Date(),
            }),
          );
        },
        onMessage: (message): void => {
          this.logger.debug(`Message received from ${message.from}`, {
            sessionId: id,
            messageId: message.id,
            from: message.from,
            action: 'message_received',
          });
          // Update last active timestamp
          this.safely('touch:lastActiveAt', id, () => this.sessionRepository.update(id, { lastActiveAt: new Date() }));
          // Convert IncomingMessage to plain object for dispatch
          const messageData = { ...message };

          // Execute hook for message received - plugins can modify or stop processing.
          //
          // A plugin that *returns* `continue: false` has deliberately taken ownership of
          // the message. A plugin that *throws* is a different case: previously the
          // rejection skipped the `.then()` below, so one broken plugin silently swallowed
          // every inbound message for that session — no webhook, no WebSocket event, no
          // error the operator could act on. A crash must not mean "drop the message", so
          // the original payload is delivered unchanged instead.
          this.safely('hook:message:received', id, async () => {
            let finalMessage = messageData;

            try {
              const result = await this.hookManager.execute('message:received', messageData, {
                sessionId: id,
                source: 'Engine',
              });

              if (!result.continue) {
                // Plugin stopped processing (e.g., auto-reply handled it)
                return;
              }
              finalMessage = result.data || messageData;
            } catch (error: unknown) {
              this.logger.error('Plugin threw while handling an incoming message', String(error), {
                sessionId: id,
                messageId: message.id,
                action: 'hook_plugin_failed',
              });
            }

            // Dispatch to webhooks with potentially modified message
            this.safely('webhook:message.received', id, () =>
              this.webhookService.dispatch(id, 'message.received', finalMessage),
            );
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage);
          });
        },
        onDisconnected: (reason: string): void => {
          this.logger.warn(`Session disconnected: ${reason}`, {
            sessionId: id,
            reason,
            action: 'disconnected',
          });

          // Execute hook for disconnected event
          this.safely('hook:session:disconnected', id, () =>
            this.hookManager.execute(
              'session:disconnected',
              { reason },
              {
                sessionId: id,
                source: 'Engine',
              },
            ),
          );

          this.safely('status:disconnected', id, () => this.updateStatus(id, SessionStatus.DISCONNECTED));

          // Attempt to reconnect
          this.scheduleReconnect(id, session, reason);
        },
        onStateChanged: (engineState: EngineStatus): void => {
          const statusMap: Record<EngineStatus, SessionStatus> = {
            [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
            [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
            [EngineStatus.QR_READY]: SessionStatus.QR_READY,
            [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
            [EngineStatus.READY]: SessionStatus.READY,
            [EngineStatus.FAILED]: SessionStatus.FAILED,
          };
          const newStatus = statusMap[engineState];
          if (newStatus) {
            this.safely(`status:${newStatus}`, id, () => this.updateStatus(id, newStatus));
          }
        },
      });
    } catch (error: unknown) {
      // A failed initialize can leave a partially launched Chromium behind. Destroy it
      // before giving up, otherwise it is unreachable and leaks for the process lifetime.
      await this.destroyEngineQuietly(engine, id, 'init_failed');
      this.engines.delete(id);
      this.reconnectStates.delete(id);
      this.logger.error(
        `Engine initialization failed for session: ${session.name}`,
        error instanceof Error ? error.message : String(error),
        { sessionId: id, action: 'engine_init_failed' },
      );
      throw error;
    }

    // Only publish the engine once it is actually usable. Registering before the await
    // would let a failed start leave a phantom entry that makes every later start()
    // reply "Session is already started" with no way to recover short of stop+start.
    this.engines.set(id, engine);

    // Deliberately no `updateStatus(id, INITIALIZING)` here.
    //
    // It used to sit at the end of initializeEngine(), and it silently destroyed the QR
    // code. whatsapp-web.js emits `qr` *during* `initialize()`, so by the time that await
    // resolves the session is already QR_READY. This write then overwrote it back to
    // `initializing`, and the state only recovered when the driver happened to re-emit
    // `qr` about a minute later. Measured on a real browser: the QR was served after ~3s
    // while the API still reported `initializing` for 61s, so a dashboard had no way to
    // tell the operator to scan anything.
    //
    // The engine already reports INITIALIZING itself via `setStatus()` at the top of its
    // own `initialize()`, which reaches here through `onStateChanged`. Writing it again
    // afterwards is both redundant and racy.
  }

  private scheduleReconnect(id: string, session: Session, reason?: string): void {
    const state = this.reconnectStates.get(id);
    if (!state) return;

    // A logout / auth failure / ban will never be fixed by reconnecting. Retrying only
    // burns Chromium launches and re-prompts for a QR the operator has to scan again.
    if (reason && TERMINAL_DISCONNECT_PATTERNS.some(pattern => pattern.test(reason))) {
      this.logger.error(`Session ${session.name} disconnected permanently (${reason}); not reconnecting`, undefined, {
        sessionId: id,
        reason,
        action: 'reconnect_skipped_terminal',
      });
      this.cancelReconnect(id);
      return;
    }

    // Hard stop for a session that keeps flapping. Without this, a session that connects
    // and instantly drops would reset its counter on every success and never reach
    // maxAttempts, looping forever.
    if (state.flappingCount >= MAX_CONSECUTIVE_FLAPS) {
      this.logger.error(
        `Session ${session.name} is flapping (${state.flappingCount} consecutive short-lived ` +
          `connections); automatic reconnect disabled, manual restart required`,
        undefined,
        { sessionId: id, action: 'reconnect_disabled_flapping' },
      );
      this.cancelReconnect(id);
      return;
    }

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      return;
    }

    // Exponential backoff with *full* jitter: the delay is drawn uniformly from
    // [0, base * 2^attempts]. The previous `+ Math.random() * 1000` only spread attempts by
    // 0-1s against a 5s base, so sessions created together reconnected in lockstep and
    // stampeded WhatsApp's servers.
    const ceiling = state.baseDelay * Math.pow(2, state.attempts);
    const delay = Math.round(Math.random() * ceiling);
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.locks.withLock(id, () => this.executeReconnect(id, session, state));
    }, delay);
    // Do not hold the event loop open purely for a pending reconnect.
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        this.engines.delete(id);
        await this.destroyEngineQuietly(oldEngine, id, 'reconnect');
      }

      // Re-initialize
      await this.initializeEngine(id, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  /**
   * Destroys an engine without ever rejecting. A failure here is logged and swallowed so
   * that one wedged browser cannot abort a shutdown loop, block a session deletion, or
   * consume every remaining reconnect attempt.
   */
  private async destroyEngineQuietly(engine: IWhatsAppEngine, sessionId: string, context: string): Promise<void> {
    try {
      await engine.destroy();
    } catch (error: unknown) {
      this.logger.error(
        `Failed to destroy engine for session ${sessionId}`,
        error instanceof Error ? error.message : String(error),
        { sessionId, action: 'engine_destroy_failed', context },
      );
    }
  }

  /**
   * Runs a fire-and-forget task, logging (never rethrowing) any failure.
   *
   * Engine callbacks are synchronous `void` handlers invoked from whatsapp-web.js event
   * emitters. Without this, any rejected promise from them (a transient SQLITE_BUSY, a
   * plugin throwing, a webhook lookup failing) becomes an unhandled rejection, and Node
   * terminates the process by default. A single bad message would take the whole gateway
   * offline.
   */
  private safely(label: string, sessionId: string, task: () => Promise<unknown>): void {
    void (async () => {
      try {
        await task();
      } catch (error: unknown) {
        this.logger.error(`Background task failed: ${label}`, error instanceof Error ? error.message : String(error), {
          sessionId,
          action: 'background_task_failed',
          task: label,
        });
      }
    })();
  }

  async stop(id: string): Promise<Session> {
    return this.locks.withLock(id, async () => {
      const session = await this.findOne(id);

      // Cancel any reconnection attempts
      this.cancelReconnect(id);

      const engine = this.engines.get(id);

      if (engine) {
        this.engines.delete(id);
        try {
          await engine.disconnect();
        } catch (error: unknown) {
          this.logger.error(
            `Failed to disconnect engine for session ${session.name}`,
            error instanceof Error ? error.message : String(error),
            { sessionId: id, action: 'engine_disconnect_failed' },
          );
        }
      }

      this.logger.log(`Session stopped: ${session.name}`, {
        sessionId: id,
        action: 'stop',
      });
      await this.updateStatus(id, SessionStatus.DISCONNECTED);
      return this.findOne(id);
    });
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
