import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { SessionService } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { EngineEventCallbacks, EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Callbacks are optional on the real interface; these tests drive them directly, so the
 * lifecycle ones are required. `onMessage` is required too -- leaving it optional made
 * `callbacks.onMessage(...)` an "object possibly undefined" call under the root tsconfig.
 */
type CapturedCallbacks = Required<
  Pick<EngineEventCallbacks, 'onQRCode' | 'onReady' | 'onDisconnected' | 'onStateChanged' | 'onMessage'>
> &
  Record<string, unknown>;

/** The callback bag the service passed to `engine.initialize()`. */
function firstEngineCallbacks(initialize: jest.Mock): CapturedCallbacks {
  const calls = initialize.mock.calls as [CapturedCallbacks][];
  return calls[0][0];
}

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.CREATED,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SessionService', () => {
  let service: SessionService;
  let repository: jest.Mocked<Partial<Repository<Session>>>;
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let engineFactory: jest.Mocked<Partial<EngineFactory>>;
  let eventsGateway: jest.Mocked<Partial<EventsGateway>>;
  let webhookService: jest.Mocked<Partial<WebhookService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let mockEngine: Record<string, jest.Mock>;

  beforeEach(async () => {
    repository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
          remove: jest.fn().mockResolvedValue(undefined),
        };
        return cb(manager);
      }),
    };

    mockEngine = {
      initialize: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      getQRCode: jest.fn().mockReturnValue(null),
      getGroups: jest.fn().mockResolvedValue([]),
    };

    engineFactory = {
      create: jest.fn().mockReturnValue(mockEngine),
    };

    eventsGateway = {
      emitSessionStatus: jest.fn(),
      emitMessage: jest.fn(),
    };

    webhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({ continue: true, data: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: getRepositoryToken(Session, 'data'),
          useValue: repository,
        },
        {
          provide: getDataSourceToken('data'),
          useValue: dataSource,
        },
        { provide: EngineFactory, useValue: engineFactory },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: WebhookService, useValue: webhookService },
        { provide: HookManager, useValue: hookManager },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a new session with CREATED status', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(null); // no duplicate
      (repository.create as jest.Mock).mockReturnValue(session);
      (repository.save as jest.Mock).mockResolvedValue(session);

      const result = await service.create({ name: 'test-session' });

      expect(result.name).toBe('test-session');
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ status: SessionStatus.CREATED }));
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:created',
        session,
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it('should throw ConflictException if session name already exists', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await expect(service.create({ name: 'test-session' })).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll / findOne / findByName ────────────────────────────────

  describe('findAll', () => {
    it('should return all sessions ordered by createdAt DESC', async () => {
      const sessions = [createMockSession(), createMockSession({ id: 'sess-2' })];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return session by id', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findOne('sess-uuid-1');
      expect(result.id).toBe('sess-uuid-1');
    });

    it('should throw NotFoundException if session not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByName', () => {
    it('should return session by name', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findByName('test-session');
      expect(result.name).toBe('test-session');
    });

    it('should throw NotFoundException if name not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findByName('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should stop engine and remove session from DB', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.remove as jest.Mock).mockResolvedValue(session);

      await service.delete('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:deleted',
        expect.objectContaining({ id: 'sess-uuid-1', name: 'test-session' }),
        expect.any(Object),
      );
    });

    it('should destroy running engine before deleting', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.save as jest.Mock).mockImplementation(s => Promise.resolve(s));
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.remove as jest.Mock).mockResolvedValue(session);

      // Start the session first to create an engine
      await service.start('sess-uuid-1');

      // Now delete
      await service.delete('sess-uuid-1');

      expect(mockEngine.destroy).toHaveBeenCalled();
    });
  });

  // ── start ─────────────────────────────────────────────────────────

  describe('start', () => {
    it('should create engine and persist INITIALIZING when the engine reports it', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(engineFactory.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'test-session' }));
      expect(mockEngine.initialize).toHaveBeenCalled();

      // INITIALIZING is persisted from the engine's own `setStatus()` via `onStateChanged`,
      // not written by `start()` itself. See the "QR race" note in initializeEngine().
      const callbacks = firstEngineCallbacks(mockEngine.initialize);
      callbacks.onStateChanged(EngineStatus.INITIALIZING);

      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.INITIALIZING,
      });
    });

    it('should not overwrite QR_READY when the engine emits a QR during initialize', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // whatsapp-web.js emits `qr` while `initialize()` is still awaiting. The old
      // `start()` wrote INITIALIZING *after* that await resolved, clobbering the QR and
      // leaving the API stuck on `initializing` for ~61s on a real browser.
      mockEngine.initialize.mockImplementation((cb: CapturedCallbacks) => {
        cb.onStateChanged(EngineStatus.INITIALIZING);
        cb.onQRCode('data:image/png;base64,AAAA');
        return Promise.resolve();
      });

      await service.start('sess-uuid-1');

      const statuses = (repository.update as jest.Mock).mock.calls.map(
        (call: [string, { status: SessionStatus }]) => call[1].status,
      );
      expect(statuses).toContain(SessionStatus.INITIALIZING);
      expect(statuses[statuses.length - 1]).toBe(SessionStatus.QR_READY);
    });

    it('should throw BadRequestException if session already started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      await expect(service.start('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should execute session:starting hook before initializing engine', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:starting',
        expect.objectContaining({ sessionId: 'sess-uuid-1' }),
        expect.any(Object),
      );
    });
  });

  // ── stop ──────────────────────────────────────────────────────────

  describe('stop', () => {
    it('should disconnect engine and set status to DISCONNECTED', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Start first
      await service.start('sess-uuid-1');

      // Stop
      await service.stop('sess-uuid-1');

      expect(mockEngine.disconnect).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── getQRCode ─────────────────────────────────────────────────────

  describe('getQRCode', () => {
    it('should throw BadRequestException if engine not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should return QR code from engine', async () => {
      const session = createMockSession({ status: SessionStatus.QR_READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue('data:image/png;base64,iVBOR...');

      const result = await service.getQRCode('sess-uuid-1');

      expect(result.qrCode).toBe('data:image/png;base64,iVBOR...');
    });

    it('should throw if session is READY (already authenticated)', async () => {
      const session = createMockSession({ status: SessionStatus.READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue(null);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow('already authenticated');
    });
  });

  // ── getStats ──────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return correct session statistics', async () => {
      const sessions = [
        createMockSession({ status: SessionStatus.READY }),
        createMockSession({ id: 'sess-2', status: SessionStatus.READY }),
        createMockSession({ id: 'sess-3', status: SessionStatus.DISCONNECTED }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const stats = await service.getStats();

      expect(stats.total).toBe(3);
      expect(stats.ready).toBe(2);
      expect(stats.disconnected).toBe(1);
      expect(stats.byStatus[SessionStatus.READY]).toBe(2);
      expect(stats.memoryUsage).toBeDefined();
    });
  });

  // ── getActiveCount / isActive ─────────────────────────────────────

  describe('getActiveCount', () => {
    it('should return 0 when no engines are running', () => {
      expect(service.getActiveCount()).toBe(0);
    });

    it('should return correct count after starting sessions', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.getActiveCount()).toBe(1);
    });
  });

  describe('isActive', () => {
    it('should return false for inactive session', () => {
      expect(service.isActive('nonexistent')).toBe(false);
    });

    it('should return true for active session', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.isActive('sess-uuid-1')).toBe(true);
    });
  });

  // ── onModuleInit ──────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('should reset active sessions to DISCONNECTED on startup', async () => {
      (repository.update as jest.Mock).mockResolvedValue({ affected: 3 });

      await service.onModuleInit();

      expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() as string }), {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── onModuleDestroy ───────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('should destroy all running engines on shutdown', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      await service.onModuleDestroy();

      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(service.getActiveCount()).toBe(0);
    });

    it('keeps tearing down remaining engines when one destroy() rejects', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const failingEngine = {
        ...mockEngine,
        destroy: jest.fn().mockRejectedValue(new Error('browser wedged')),
      };
      const healthyEngine = {
        ...mockEngine,
        destroy: jest.fn().mockResolvedValue(undefined),
      };
      (engineFactory.create as jest.Mock).mockReturnValueOnce(failingEngine).mockReturnValueOnce(healthyEngine);

      (repository.findOne as jest.Mock)
        .mockResolvedValueOnce(session) // start #1 (sess-uuid-1)
        .mockResolvedValueOnce(createMockSession({ id: 'sess-2' })) // start #2 (sess-2)
        .mockResolvedValue(session);

      await service.start('sess-uuid-1');
      await service.start('sess-2');
      expect(service.getActiveCount()).toBe(2);

      // A rejecting engine must not abort the loop and strand the other browser.
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();

      expect(failingEngine.destroy).toHaveBeenCalled();
      expect(healthyEngine.destroy).toHaveBeenCalled();
      expect(service.getActiveCount()).toBe(0);
    });
  });

  // ── Stability: concurrency ───────────────────────────────────────

  describe('concurrent lifecycle safety', () => {
    it('rejects a second concurrent start() instead of orphaning a browser', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Make initialize() slow enough that both calls overlap if unguarded.
      let releaseInit: () => void = () => undefined;
      const initGate = new Promise<void>(resolve => {
        releaseInit = resolve;
      });
      mockEngine.initialize.mockImplementation(async () => {
        await initGate;
      });

      const first = service.start('sess-uuid-1');
      const second = service.start('sess-uuid-1');

      releaseInit();
      await first;
      await expect(second).rejects.toThrow(BadRequestException);

      // Exactly one engine must have been created, not two.
      expect(engineFactory.create).toHaveBeenCalledTimes(1);
      expect(service.getActiveCount()).toBe(1);
    });

    it('does not register an engine when initialize() fails, and destroys the half-built one', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      mockEngine.initialize.mockRejectedValue(new Error('chromium failed to start'));

      await expect(service.start('sess-uuid-1')).rejects.toThrow('chromium failed to start');

      // Phantom map entries made every later start() reply "already started".
      expect(service.getActiveCount()).toBe(0);
      // The partially launched browser must not be leaked.
      expect(mockEngine.destroy).toHaveBeenCalled();

      // Recovery: a subsequent start must be able to succeed.
      mockEngine.initialize.mockResolvedValue(undefined);
      await expect(service.start('sess-uuid-1')).resolves.toBeDefined();
      expect(service.getActiveCount()).toBe(1);
    });

    it('delete() succeeds even when engine.destroy() rejects', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.remove as jest.Mock).mockResolvedValue(session);

      await service.start('sess-uuid-1');
      mockEngine.destroy.mockRejectedValue(new Error('teardown failed'));

      await expect(service.delete('sess-uuid-1')).resolves.toBeUndefined();
      expect(service.getActiveCount()).toBe(0);
    });

    it('stop() succeeds even when engine.disconnect() rejects', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.disconnect.mockRejectedValue(new Error('socket gone'));

      await expect(service.stop('sess-uuid-1')).resolves.toBeDefined();
      expect(service.getActiveCount()).toBe(0);
    });
  });

  // ── Stability: engine callbacks never reject ────────────────────

  describe('engine callback isolation', () => {
    /** Grabs the callbacks handed to engine.initialize(). */
    async function startAndCaptureCallbacks(): Promise<CapturedCallbacks> {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');
      return firstEngineCallbacks(mockEngine.initialize);
    }

    it('does not produce an unhandled rejection when a DB write fails on message', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const callbacks = await startAndCaptureCallbacks();
        // Simulate a transient SQLITE_BUSY on the lastActiveAt touch.
        (repository.update as jest.Mock).mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

        callbacks.onMessage({ id: 'm1', from: '628@c.us', body: 'hi' } as never);
        callbacks.onQRCode('data:image/png;base64,AAAA');

        // Let the microtask queue and the rejection-detection turn run.
        await new Promise(r => setTimeout(r, 50));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('does not produce an unhandled rejection when a plugin throws on message', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const callbacks = await startAndCaptureCallbacks();
        (hookManager.execute as jest.Mock).mockRejectedValue(new Error('plugin exploded'));
        (webhookService.dispatch as jest.Mock).mockRejectedValue(new Error('webhook db down'));

        callbacks.onMessage({ id: 'm2', from: '628@c.us', body: 'hi' } as never);

        await new Promise(r => setTimeout(r, 50));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('does not produce an unhandled rejection when a status update fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const callbacks = await startAndCaptureCallbacks();
        (repository.update as jest.Mock).mockRejectedValue(new Error('write failed'));

        callbacks.onReady('628123', 'Test');
        callbacks.onStateChanged('DISCONNECTED' as never);

        await new Promise(r => setTimeout(r, 50));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });

  // ── Stability: reconnect behaviour ───────────────────────────────

  describe('reconnect policy', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /**
     * Drives a session to READY and then disconnects it, capturing the callback used to
     * emit each lifecycle event.
     */
    async function primeReadySession(): Promise<CapturedCallbacks> {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');
      return firstEngineCallbacks(mockEngine.initialize);
    }

    it('does NOT auto-reconnect after an explicit logout', async () => {
      const callbacks = await primeReadySession();

      // whatsapp-web.js reports a user-requested logout as this disconnect reason.
      callbacks.onDisconnected('LOGOUT');

      // A logout needs a fresh QR scan, so retrying is pointless churn.
      expect(jest.getTimerCount()).toBe(0);
      expect(service.getActiveCount()).toBe(1);
    });

    it('does NOT auto-reconnect after an authentication failure', async () => {
      const callbacks = await primeReadySession();

      callbacks.onDisconnected('Authentication failed');

      expect(jest.getTimerCount()).toBe(0);
    });

    it('does NOT auto-reconnect after a ban/block', async () => {
      const callbacks = await primeReadySession();

      callbacks.onDisconnected('device banned');

      expect(jest.getTimerCount()).toBe(0);
    });

    it('still schedules a reconnect for a transient network drop', async () => {
      const callbacks = await primeReadySession();

      callbacks.onDisconnected('connection lost');

      expect(jest.getTimerCount()).toBe(1);
    });

    it('gives up instead of looping forever when a session keeps flapping', async () => {
      const callbacks = await primeReadySession();

      // Simulate repeated connect-then-immediately-drop cycles. Each `onReady` inside the
      // flap window must count as a flap rather than resetting the attempt counter,
      // otherwise maxAttempts is never reached and this loops indefinitely.
      for (let i = 0; i < 5; i++) {
        callbacks.onReady('628123', 'Test');
        callbacks.onDisconnected('connection lost');
        // Run whatever reconnect timer is pending so the next cycle starts clean.
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
      }

      // After the flap budget is spent, no further reconnect may be scheduled.
      callbacks.onReady('628123', 'Test');
      callbacks.onDisconnected('connection lost');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('resets the flap counter after a genuinely stable connection', async () => {
      const callbacks = await primeReadySession();

      callbacks.onReady('628123', 'Test');
      // Move past the flap window so this connection counts as stable.
      jest.advanceTimersByTime(120_000);
      callbacks.onReady('628123', 'Test');
      callbacks.onDisconnected('connection lost');

      // A stable session must still be eligible for reconnection.
      expect(jest.getTimerCount()).toBe(1);
    });
  });
});
