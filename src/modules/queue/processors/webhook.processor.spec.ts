import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { WebhookProcessor } from './webhook.processor';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { HookManager } from '../../../core/hooks';
import { WebhookJobData } from '../../webhook/webhook.service';

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let update: jest.MockedFunction<(id: string, patch: Record<string, unknown>) => Promise<unknown>>;
  let execute: jest.MockedFunction<(event: string, data: unknown, context: unknown) => Promise<unknown>>;
  let config: ConfigService;
  let mockRawFetch: jest.Mock | undefined;

  beforeEach(() => {
    update = jest.fn().mockResolvedValue({ affected: 1 });
    execute = jest.fn().mockResolvedValue({ continue: true, data: {} });
    config = {
      get: jest.fn().mockImplementation(<T>(key: string, def?: T): T => {
        if (key === 'webhook.timeout') return 10000 as T;
        return def as T;
      }),
    } as unknown as ConfigService;

    processor = new WebhookProcessor(
      { update } as unknown as import('typeorm').Repository<Webhook>,
      { execute } as unknown as HookManager,
      config,
    );
  });

  afterEach(() => {
    mockRawFetch?.mockReset();
    delete (global as { fetch?: unknown }).fetch;
  });

  const jobData = (overrides: Partial<WebhookJobData> = {}): WebhookJobData => ({
    webhookId: 'wh-1',
    url: 'https://example.com/hook',
    event: 'message.received',
    payload: {
      event: 'message.received',
      timestamp: '2026-10-06T10:00:00Z',
      sessionId: 'sess-1',
      idempotencyKey: 'k',
      deliveryId: 'del-1',
      data: {},
    },
    signature: '',
    headers: { 'Content-Type': 'application/json' },
    attempt: 1,
    maxRetries: 3,
    ...overrides,
  });

  const makeJob = (overrides: { data?: Partial<WebhookJobData>; attemptsMade?: number } = {}): Job<WebhookJobData> =>
    ({
      id: 'job-1',
      name: 'webhook-wh-1',
      data: jobData(overrides.data),
      attemptsMade: overrides.attemptsMade ?? 0,
      failedReason: '',
      timestamp: Date.now(),
    }) as unknown as Job<WebhookJobData>;

  const okResponse = { ok: true, status: 200, statusText: 'OK', body: undefined };

  function stubFetch(response: () => Promise<unknown>): void {
    mockRawFetch = jest.fn(response);
    global.fetch = mockRawFetch;
  }

  describe('process', () => {
    it('delivers successfully and records success telemetry', async () => {
      stubFetch(async () => okResponse);

      const result = await processor.process(makeJob());

      expect(result).toEqual(expect.objectContaining({ success: true, statusCode: 200 }));
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ method: 'POST' }),
      );
      const calls = update.mock.calls as [string, Record<string, unknown>][];
      const [, patch] = calls[0];
      expect(patch.lastSuccessAt).toBeInstanceOf(Date);
      expect(patch.lastStatusCode).toBe(200);
      expect(patch.lastError).toBeNull();
      expect(patch.consecutiveFailures).toBe(0);
      expect(execute).toHaveBeenCalledWith(
        'webhook:delivered',
        expect.objectContaining({ webhookId: 'wh-1', statusCode: 200 }),
        expect.anything(),
      );
    });

    it('records the last failure and fires webhook:error on an exhausted retry budget', async () => {
      stubFetch(async () => ({ ok: false, status: 500, statusText: 'Boom', body: undefined }));
      const job = makeJob({ attemptsMade: 3 }); // maxRetries = 3 -> final attempt

      await expect(processor.process(job)).rejects.toThrow('HTTP 500: Boom');

      const calls = update.mock.calls as [string, Record<string, unknown>][];
      const [, failurePatch] = calls[0];
      expect(failurePatch.lastFailureAt).toBeInstanceOf(Date);
      expect(failurePatch.lastError).toBe('HTTP 500: Boom');
      expect(typeof failurePatch.consecutiveFailures).toBe('function');
      expect(execute).toHaveBeenCalledWith(
        'webhook:error',
        expect.objectContaining({ webhookId: 'wh-1', attempt: 4, deliveryId: 'del-1' }),
        expect.anything(),
      );
    });

    it('does not fire the terminal error hook until retries are exhausted', async () => {
      stubFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable', body: undefined }));

      await expect(processor.process(makeJob({ attemptsMade: 0 }))).rejects.toThrow('HTTP 503');

      // Telemetry is recorded, but no webhook:error hook for a non-final attempt.
      expect(update).toHaveBeenCalledWith('wh-1', expect.objectContaining({ lastError: 'HTTP 503: Unavailable' }));
      expect(execute).not.toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
    });

    it('does not let stats persistence failure fail an already-delivered job', async () => {
      update.mockRejectedValueOnce(new Error('db down'));
      stubFetch(async () => okResponse);

      const result = await processor.process(makeJob());

      expect(result.success).toBe(true);
    });
  });

  describe('onJobFailed', () => {
    it('does not touch the database or clobber the configured retryCount', () => {
      processor.onJobFailed(makeJob({ attemptsMade: 3 }), new Error('HTTP 503: Unavailable'));

      expect(update).not.toHaveBeenCalled();
    });

    it('returns early when the failed-job payload is missing (BullMQ purge race)', () => {
      processor.onJobFailed(undefined, new Error('x'));
      expect(update).not.toHaveBeenCalled();
    });
  });
});
