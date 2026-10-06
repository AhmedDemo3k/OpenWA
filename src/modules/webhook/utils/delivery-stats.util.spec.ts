import { recordDeliveryOutcome } from './delivery-stats.util';

describe('recordDeliveryOutcome', () => {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const repository = { update } as unknown as Parameters<typeof recordDeliveryOutcome>[0];

  beforeEach(() => {
    update.mockClear();
  });

  it('records success telemetry and resets the failure counter', async () => {
    const at = new Date('2026-10-06T10:00:00Z');

    await recordDeliveryOutcome(repository, 'wh-1', { ok: true, at, statusCode: 200 });

    expect(update).toHaveBeenCalledWith('wh-1', {
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastTriggeredAt: at,
      lastStatusCode: 200,
      lastError: null,
      consecutiveFailures: 0,
    });
  });

  it('records failure telemetry and increments the failure counter without clobbering the retry budget', async () => {
    const at = new Date('2026-10-06T11:00:00Z');

    await recordDeliveryOutcome(repository, 'wh-1', { ok: false, at, statusCode: 500, error: 'HTTP 500: Boom' });

    const calls = update.mock.calls as [string, Record<string, unknown>][];
    const [webhookId, patch] = calls[0];
    expect(webhookId).toBe('wh-1');
    expect(patch.lastFailureAt).toEqual(at);
    expect(patch.lastAttemptAt).toEqual(at);
    expect(patch.lastStatusCode).toBe(500);
    expect(patch.lastError).toBe('HTTP 500: Boom');
    // Increment is expressed as a raw SQL expression so concurrent attempts cannot
    // lose an increment; and the retry budget column is never touched.
    expect(typeof patch.consecutiveFailures).toBe('function');
    expect(patch.consecutiveFailures()).toBe('"consecutiveFailures" + 1');
    expect(patch.retryCount).toBeUndefined();
  });

  it('uses a sensible default error when the failure has no message', async () => {
    await recordDeliveryOutcome(repository, 'wh-1', { ok: false, at: new Date() });

    const calls = update.mock.calls as [string, Record<string, unknown>][];
    const [, patch] = calls[0];
    expect(patch.lastError).toBe('Unknown delivery failure');
  });

  it('propagates repository errors to the caller', async () => {
    update.mockRejectedValueOnce(new Error('db down'));

    await expect(recordDeliveryOutcome(repository, 'wh-1', { ok: true, at: new Date() })).rejects.toThrow('db down');
  });
});
