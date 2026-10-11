import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { WebhookService, WebhookPayload } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryLog } from './entities/webhook-delivery-log.entity';
import { WebhookNonce } from './entities/webhook-nonce.entity';
import { HookManager } from '../../core/hooks';
import { QUEUE_NAMES } from '../queue/queue-names';
import { Session } from '../session/entities/session.entity';

function createMockWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-uuid-1',
    sessionId: 'sess-1',
    url: 'https://example.com/webhook',
    events: ['message.received'],
    secret: null,
    headers: {},
    active: true,
    retryCount: 3,
    lastTriggeredAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    consecutiveFailures: 0,
    paused: false,
    pausedAt: null,
    pauseReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let repository: jest.Mocked<Partial<Repository<Webhook>>>;
  let deliveryLogRepo: jest.Mocked<Partial<Repository<WebhookDeliveryLog>>>;
  let nonceRepo: jest.Mocked<Partial<Repository<WebhookNonce>>>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let webhookQueue: jest.Mocked<Record<string, jest.Mock>>;

  // Shared providers for every TestingModule built in this suite, since the service now
  // also injects the delivery-log and nonce repositories.
  function extraProviders() {
    return [
      { provide: getRepositoryToken(WebhookDeliveryLog, 'data'), useValue: deliveryLogRepo },
      { provide: getRepositoryToken(WebhookNonce, 'data'), useValue: nonceRepo },
    ];
  }

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
    };

    deliveryLogRepo = {
      create: jest.fn((v: Partial<WebhookDeliveryLog>) => v),
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Partial<Repository<WebhookDeliveryLog>>>;

    nonceRepo = {
      create: jest.fn((v: Partial<WebhookNonce>) => v),
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Partial<Repository<WebhookNonce>>>;

    configService = {
      get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.retryDelay') return 100;
        if (key === 'webhook.timeout') return 10000;
        return def as T;
      }),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received', payload: {} },
      }),
    };

    webhookQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
        ...extraProviders(),
        { provide: ConfigService, useValue: configService },
        { provide: HookManager, useValue: hookManager },
        { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a webhook with default events', async () => {
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      const result = await service.create('sess-1', {
        url: 'https://example.com/webhook',
      });

      expect(result.sessionId).toBe('sess-1');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          events: ['message.received'],
        }),
      );
    });

    it('should create webhook with custom events and secret', async () => {
      const webhook = createMockWebhook({
        events: ['*'],
        secret: 'my-secret',
      });
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await service.create('sess-1', {
        url: 'https://example.com/webhook',
        events: ['*'],
        secret: 'my-secret',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          events: ['*'],
          secret: 'my-secret',
        }),
      );
    });

    it('rejects private/loopback URLs by default', async () => {
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await expect(service.create('sess-1', { url: 'http://localhost:3000/hook' })).rejects.toThrow('Private/loopback');
      await expect(service.create('sess-1', { url: 'https://example.com/hook' })).resolves.toBeDefined();
      expect(repository.create).toHaveBeenCalledTimes(1);
    });

    it('enforces the configured allowlist', async () => {
      configService.get = jest.fn().mockImplementation(<T>(key: string, def?: T): T => {
        if (key === 'webhook.allowedUrls') return ['https://ok.example.com'] as unknown as T;
        return def as T;
      });
      await expect(service.create('sess-1', { url: 'https://other.example.com/hook' })).rejects.toThrow('allowlist');
    });
  });

  describe('listDeliveryLogs', () => {
    it('lists recent delivery attempts with ownership check', async () => {
      const logs = [{ id: 'log-1' }] as unknown as WebhookDeliveryLog[];
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook({ sessionId: 'sess-1' }));
      (deliveryLogRepo.find as jest.Mock).mockResolvedValue(logs);

      await expect(service.listDeliveryLogs('sess-1', 'wh-1', 25)).resolves.toEqual(logs);
      expect(deliveryLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { webhookId: 'wh-1' }, take: 25 }),
      );
    });

    it('treats a cross-session webhook as not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook({ sessionId: 'other-sess' }));
      await expect(service.listDeliveryLogs('sess-1', 'wh-1')).rejects.toThrow('not found');
    });
  });

  // ── findBySession / findAll / findOne ──────────────────────────────

  describe('findBySession', () => {
    it('should return webhooks for a session', async () => {
      const webhooks = [createMockWebhook()];
      (repository.find as jest.Mock).mockResolvedValue(webhooks);

      const result = await service.findBySession('sess-1');

      expect(result).toHaveLength(1);
      expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'sess-1' } }));
    });
  });

  describe('findAll', () => {
    it('should return all webhooks ordered by createdAt DESC', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll();

      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return webhook by id', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);

      const result = await service.findOne('wh-uuid-1');
      expect(result.id).toBe('wh-uuid-1');
    });

    it('should throw NotFoundException if not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update only provided fields', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.save as jest.Mock).mockImplementation(w => Promise.resolve(w));

      const result = await service.update('wh-uuid-1', { url: 'https://new-url.com/hook' });

      expect(result.url).toBe('https://new-url.com/hook');
      expect(result.events).toEqual(['message.received']); // unchanged
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should remove the webhook', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.remove as jest.Mock).mockResolvedValue(webhook);

      await service.delete('wh-uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(webhook);
    });
  });

  // ── dispatch (direct mode — queue disabled) ───────────────────────

  describe('dispatch (direct mode)', () => {
    const mockFetch = jest.fn();

    beforeEach(() => {
      global.fetch = mockFetch as typeof global.fetch;
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => {
      mockFetch.mockReset();
    });

    it('should dispatch to webhooks matching the event', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Mock hook to return the payload properly
      const mockPayload: WebhookPayload = {
        event: 'message.received',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        idempotencyKey: 'test-key',
        deliveryId: 'test-delivery',
        data: { from: '628123456789@c.us' },
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: mockPayload,
        },
      });

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should NOT dispatch to webhooks that do not match the event', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      await service.dispatch('sess-1', 'session.ready', { phone: '628123456789' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should dispatch to webhooks with wildcard (*) event filter', async () => {
      const webhook = createMockWebhook({ events: ['*'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const wildcardPayload: WebhookPayload = {
        event: 'anything.goes',
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: '',
        deliveryId: '',
        data: {},
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'anything.goes',
          payload: wildcardPayload,
        },
      });

      await service.dispatch('sess-1', 'anything.goes', {});

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should skip dispatch when plugin cancels via hook', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: false, data: {} });

      await service.dispatch('sess-1', 'message.received', {});

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('attaches a timestamp and nonce when replay protection is enabled', async () => {
      const replayConfig = {
        get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | number => {
          if (key === 'queue.enabled') return false;
          if (key === 'webhook.enableReplayProtection') return true;
          if (key === 'webhook.replayTtlMs') return 300_000;
          return def as T;
        }),
      } as unknown as ConfigService;

      const replayService = new WebhookService(repository, deliveryLogRepo, nonceRepo, replayConfig, hookManager);

      const webhook = createMockWebhook({ events: ['message.received'], secret: 's3cret' });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const capturedBody: { t?: number; nonce?: string } = {};
      let capturedHeaders: Record<string, string> = {};
      const replayFetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
        Object.assign(capturedBody, JSON.parse(opts.body as string));
        capturedHeaders = opts.headers as Record<string, string>;
        return Promise.resolve({ ok: true, status: 200 });
      });
      global.fetch = replayFetch as typeof global.fetch;

      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: {
            event: 'message.received',
            timestamp: '',
            sessionId: 'sess-1',
            idempotencyKey: 'k',
            deliveryId: 'd',
            data: {},
          },
        },
      });

      await replayService.dispatch('sess-1', 'message.received', {});

      expect(typeof capturedBody.t).toBe('number');
      expect(typeof capturedBody.nonce).toBe('string');
      expect(capturedHeaders['X-OpenWA-Nonce']).toBe(capturedBody.nonce);
      expect(capturedHeaders['X-OpenWA-Signature']).toBeTruthy();
      expect(nonceRepo.save).toHaveBeenCalled();
    });
  });

  // ── generateSignature (via dispatch) ──────────────────────────────

  describe('generateSignature', () => {
    it('should produce valid HMAC-SHA256 signature', async () => {
      const webhook = createMockWebhook({
        events: ['message.received'],
        secret: 'test-secret-123',
      });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const capturedHeaders: Record<string, string> = {};
      const mockFetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
        Object.assign(capturedHeaders, opts.headers as Record<string, string>);
        return Promise.resolve({ ok: true, status: 200 });
      });
      global.fetch = mockFetch as typeof global.fetch;

      const sigPayload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: sigPayload,
        },
      });

      await service.dispatch('sess-1', 'message.received', {});

      // Verify signature format
      expect(capturedHeaders['X-OpenWA-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify signature correctness
      const body = JSON.stringify({
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      });
      const expected = `sha256=${crypto.createHmac('sha256', 'test-secret-123').update(body).digest('hex')}`;
      expect(capturedHeaders['X-OpenWA-Signature']).toBe(expected);

      mockFetch.mockReset();
    });
  });

  // ── dispatch (queue mode) ─────────────────────────────────────────

  describe('dispatch (queue mode)', () => {
    it('should add job to queue when queue is enabled', async () => {
      // Create a new service with queue enabled
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          ...extraProviders(),
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
                if (key === 'queue.enabled') return true;
                if (key === 'webhook.retryDelay') return 5000;
                return def as T;
              }),
            },
          },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();

      const queueService = queueModule.get<WebhookService>(WebhookService);

      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      const queuePayload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: queuePayload,
        },
      });

      await queueService.dispatch('sess-1', 'message.received', {});

      expect(webhookQueue.add).toHaveBeenCalledWith(
        expect.stringContaining('webhook-'),
        expect.objectContaining({
          webhookId: 'wh-uuid-1',
          url: 'https://example.com/webhook',
          event: 'message.received',
        }),
        expect.objectContaining({
          attempts: 3,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });
  });

  // ── dead-letter queue (BullMQ queue mode) ─────────────────────────

  describe('dead-letter operations', () => {
    function makeQueueService(): Promise<TestingModule> {
      return Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          ...extraProviders(),
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
                if (key === 'queue.enabled') return true;
                if (key === 'webhook.retryDelay') return 5000;
                return def as T;
              }),
            },
          },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();
    }

    const failedJob = (overrides: Record<string, unknown> = {}) =>
      ({
        id: 'job-1',
        name: 'webhook-wh-uuid-1',
        data: {
          webhookId: 'wh-uuid-1',
          event: 'message.received',
          url: 'https://example.com/webhook',
          payload: { deliveryId: 'del-1', sessionId: 'sess-1' },
        },
        attemptsMade: 3,
        failedReason: 'HTTP 500: Internal Server Error',
        timestamp: 1728200000000,
        remove: jest.fn().mockResolvedValue(jest.fn()),
        retry: jest.fn().mockResolvedValue(jest.fn()),
        ...overrides,
      }) as unknown as Record<string, unknown>;

    it('lists only failed jobs belonging to the webhook and maps their fields', async () => {
      webhookQueue.getFailed = jest.fn().mockResolvedValue([
        failedJob(),
        // A dead-lettered job for a different webhook on the shared queue.
        failedJob({ id: 'job-2', name: 'webhook-other-uuid' }),
      ]);
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook());

      const queueService = await makeQueueService();
      const result = await queueService.get(WebhookService).listDeadLetters('sess-1', 'wh-uuid-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          jobId: 'job-1',
          event: 'message.received',
          deliveryId: 'del-1',
          attemptsMade: 3,
          failedReason: 'HTTP 500: Internal Server Error',
        }),
      );
    });

    it('rejects dead-letter operations when the queue is disabled', async () => {
      const queueService = service; // outer module has queue.enabled = false
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook());

      await expect(queueService.listDeadLetters('sess-1', 'wh-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects dead-letter operations for a webhook owned by another session', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook({ sessionId: 'sess-other' }));
      webhookQueue.getFailed = jest.fn().mockResolvedValue([]);

      const queueService = await makeQueueService();
      await expect(queueService.get(WebhookService).listDeadLetters('sess-1', 'wh-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('requeues a dead-lettered delivery via job.retry', async () => {
      const retry = jest.fn().mockResolvedValue(undefined);
      webhookQueue.getJob = jest.fn().mockResolvedValue(failedJob({ retry }));
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook());

      const queueService = await makeQueueService();
      const result = await queueService.get(WebhookService).retryDeadLetter('sess-1', 'wh-uuid-1', 'job-1');

      expect(retry).toHaveBeenCalled();
      expect(result).toEqual({ jobId: 'job-1', retried: true });
    });

    it('rejects retrying a job that does not belong to the webhook', async () => {
      webhookQueue.getJob = jest.fn().mockResolvedValue(failedJob({ name: 'webhook-someone-else' }));
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook());

      const queueService = await makeQueueService();
      const svc = queueService.get(WebhookService);

      await expect(svc.retryDeadLetter('sess-1', 'wh-uuid-1', 'job-1')).rejects.toThrow(NotFoundException);
      expect(webhookQueue.getJob).toHaveBeenCalledWith('job-1');
    });

    it('discards a dead-lettered delivery via job.remove', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      webhookQueue.getJob = jest.fn().mockResolvedValue(failedJob({ remove }));
      (repository.findOne as jest.Mock).mockResolvedValue(createMockWebhook());

      const queueService = await makeQueueService();
      const result = await queueService.get(WebhookService).removeDeadLetter('sess-1', 'wh-uuid-1', 'job-1');

      expect(remove).toHaveBeenCalled();
      expect(result).toEqual({ jobId: 'job-1', removed: true });
    });
  });
});
