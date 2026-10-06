import { Repository } from 'typeorm';
import { Webhook } from '../entities/webhook.entity';

export interface DeliveryOutcome {
  ok: boolean;
  at: Date;
  statusCode?: number | null;
  error?: string | null;
}

/**
 * Persist the outcome of a delivery attempt on the webhook row so operators can see an
 * endpoint's health without digging through logs or the queue UI.
 *
 * Success resets the failure counter; a failure bumps it and records the last error and
 * status code. The counter is incremented with a raw SQL expression so two concurrent
 * attempts (e.g. a retry racing a direct delivery) cannot lose an increment.
 *
 * The caller is expected to guard against rejection (delivery stats are never worth
 * failing an already-delivered request over).
 */
export async function recordDeliveryOutcome(
  repository: Repository<Webhook>,
  webhookId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  if (outcome.ok) {
    await repository.update(webhookId, {
      lastSuccessAt: outcome.at,
      lastAttemptAt: outcome.at,
      lastTriggeredAt: outcome.at,
      lastStatusCode: outcome.statusCode ?? null,
      lastError: null,
      consecutiveFailures: 0,
    });
    return;
  }

  await repository.update(webhookId, {
    lastFailureAt: outcome.at,
    lastAttemptAt: outcome.at,
    lastStatusCode: outcome.statusCode ?? null,
    lastError: outcome.error ?? 'Unknown delivery failure',
    consecutiveFailures: () => '"consecutiveFailures" + 1',
  });
}
