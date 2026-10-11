import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Optional } from '@nestjs/common';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { WebhookJobData } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryLog } from '../../webhook/entities/webhook-delivery-log.entity';
import { recordDeliveryOutcome } from '../../webhook/utils/delivery-stats.util';
import { extractErrorBody, truncateErrorBody } from '../../webhook/utils/error-body.util';
import { parseRetryAfter, withJitter } from '../../webhook/utils/retry.util';
import { HookManager } from '../../../core/hooks';

export interface WebhookJobResult {
  statusCode: number;
  success: boolean;
  error?: string;
  responseTime: number;
}

@Processor(QUEUE_NAMES.WEBHOOK)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = createLogger('WebhookProcessor');
  private readonly cbFailures: number;
  private readonly respectRetryAfter: boolean;
  private readonly jitterMs: number;
  private readonly maxErrorBodyChars: number;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
    @Optional()
    @InjectRepository(WebhookDeliveryLog, 'data')
    private readonly deliveryLogRepo?: Repository<WebhookDeliveryLog>,
  ) {
    super();
    this.cbFailures = this.configService.get<number>('webhook.circuitBreakerFailures', 10);
    this.respectRetryAfter = this.configService.get<boolean>('webhook.respectRetryAfter', true);
    this.jitterMs = this.configService.get<number>('webhook.jitterMs', 1000);
    this.maxErrorBodyChars = this.configService.get<number>('webhook.maxErrorBodyChars', 200);
  }

  /**
   * Persist the outcome of a delivery attempt to the delivery-log table. Best-effort: a
   * logging failure must never mask the delivery result. No-op when the repository is not
   * injected (e.g. thin unit tests).
   */
  private async logDelivery(d: Partial<WebhookDeliveryLog>): Promise<void> {
    if (!this.deliveryLogRepo) return;
    try {
      await this.deliveryLogRepo.save(this.deliveryLogRepo.create(d));
    } catch (error) {
      this.logger.warn('Failed to persist webhook delivery log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Pause a webhook once it crosses the consecutive-failure threshold so a permanently
   * dead endpoint stops consuming the retry budget. Best-effort and guarded so a thin
   * repository (tests) is unaffected.
   */
  private async maybeTripCircuit(webhookId: string): Promise<void> {
    const repo = this.webhookRepository as Partial<Repository<Webhook>>;
    if (typeof repo.findOne !== 'function' || typeof repo.update !== 'function') return;
    try {
      const webhook = await repo.findOne({ where: { id: webhookId } });
      if (!webhook || webhook.paused) return;
      if ((webhook.consecutiveFailures || 0) >= this.cbFailures) {
        await repo.update(webhookId, {
          paused: true,
          pausedAt: new Date(),
          pauseReason: `Circuit breaker: ${webhook.consecutiveFailures} consecutive failures`,
        });
        this.logger.warn('Webhook paused by circuit breaker', {
          webhookId,
          consecutiveFailures: webhook.consecutiveFailures,
          action: 'webhook_paused_circuit',
        });
      }
    } catch {
      // best-effort
    }
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const { webhookId, url, event, payload, headers, maxRetries } = job.data;
    const startTime = Date.now();
    const sessionId = payload.sessionId;

    this.logger.log(`Processing webhook job ${job.id}`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attempt: job.attemptsMade + 1,
      action: 'webhook_process_start',
    });

    // Update retry count in headers
    const requestHeaders = {
      ...headers,
      'X-OpenWA-Retry-Count': String(job.attemptsMade),
    };

    let failureStatusCode: number | null = null;
    let retryAfterMs: number | null = null;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
        // Honour WEBHOOK_TIMEOUT. This was hardcoded to 10s, so the setting silently had
        // no effect on the queued delivery path.
        signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10_000)),
      });

      const responseTime = Date.now() - startTime;
      const success = response.ok;

      if (!success) {
        failureStatusCode = response.status;
        // Capture a short, sanitized error body before draining the socket so the DLQ
        // shows the endpoint's own explanation, not just the status line.
        const errBody = await extractErrorBody(response, this.maxErrorBodyChars);
        retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null);
        // Drain the body so undici can release the socket back to the pool instead of
        // holding it until GC. A slow-to-read error response would otherwise accumulate
        // open connections across retries.
        await response.body?.cancel().catch(() => undefined);
        const suffix = errBody ? ` - ${errBody}` : '';
        const raSuffix = retryAfterMs !== null ? ` [retry-after=${retryAfterMs}ms]` : '';
        throw new Error(`HTTP ${response.status}: ${response.statusText}${suffix}${raSuffix}`);
      }

      await response.body?.cancel().catch(() => undefined);

      // Record delivery telemetry. Deliberately NOT allowed to fail the job: the endpoint
      // already received the payload, so throwing here would make BullMQ redeliver a
      // message that was in fact delivered, producing duplicates for the consumer.
      await recordDeliveryOutcome(this.webhookRepository, webhookId, {
        ok: true,
        at: new Date(),
        statusCode: response.status,
      }).catch((error: unknown) => {
        this.logger.warn('Failed to record webhook delivery stats', {
          webhookId,
          action: 'webhook_stats_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await this.logDelivery({
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        jobId: job.id ? String(job.id) : null,
        success: true,
        statusCode: response.status,
        responseTimeMs: responseTime,
        attempt: job.attemptsMade + 1,
        headers: requestHeaders,
        meta: { idempotencyKey: payload.idempotencyKey },
      });

      await this.hookManager.execute(
        'webhook:delivered',
        {
          sessionId,
          event,
          webhookId,
          deliveryId: payload.deliveryId,
          statusCode: response.status,
          responseTime,
          attempt: job.attemptsMade + 1,
        },
        { sessionId, source: 'WebhookProcessor' },
      );

      this.logger.log(`Webhook delivered successfully`, {
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        statusCode: response.status,
        responseTime,
        attempt: job.attemptsMade + 1,
        action: 'webhook_delivered',
      });

      return {
        statusCode: response.status,
        success: true,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isFinalAttempt = job.attemptsMade + 1 >= maxRetries;

      this.logger.error(`Webhook delivery failed`, errorMessage, {
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        responseTime,
        attempt: job.attemptsMade + 1,
        maxRetries,
        isFinalAttempt,
        action: 'webhook_failed',
      });

      // Execute error hook only on final failure (all retries exhausted)
      if (isFinalAttempt) {
        await this.hookManager
          .execute(
            'webhook:error',
            {
              sessionId,
              event,
              webhookId,
              deliveryId: payload.deliveryId,
              error: errorMessage,
              attempt: job.attemptsMade + 1,
            },
            { sessionId, source: 'WebhookProcessor' },
          )
          .catch((hookError: unknown) => {
            // A throwing plugin must not mask the original delivery failure.
            this.logger.warn('webhook:error hook failed', {
              webhookId,
              action: 'webhook_error_hook_failed',
              error: hookError instanceof Error ? hookError.message : String(hookError),
            });
          });
      }

      // Record failure telemetry on every failed attempt. Best-effort: a stats write must
      // never mask the original delivery failure.
      await recordDeliveryOutcome(this.webhookRepository, webhookId, {
        ok: false,
        at: new Date(),
        statusCode: failureStatusCode,
        error: errorMessage,
      }).catch(() => undefined);

      await this.logDelivery({
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        jobId: job.id ? String(job.id) : null,
        success: false,
        statusCode: failureStatusCode,
        error: truncateErrorBody(errorMessage, this.maxErrorBodyChars * 2),
        responseTimeMs: responseTime,
        attempt: job.attemptsMade + 1,
        headers: requestHeaders,
        meta: { idempotencyKey: payload.idempotencyKey, retryAfterMs },
      });

      if (isFinalAttempt) {
        await this.maybeTripCircuit(webhookId);
      }

      // Respect an explicit Retry-After: reschedule this job for that delay instead of the
      // configured exponential backoff. Best-effort and guarded so a thin mock job in unit
      // tests (no token/moveToDelayed) falls through to the normal retry path.
      const jobWithDelay = job as unknown as {
        moveToDelayed?: (ts: number, token?: string) => Promise<void>;
        token?: string;
      };
      if (
        !isFinalAttempt &&
        retryAfterMs !== null &&
        this.respectRetryAfter &&
        typeof jobWithDelay.moveToDelayed === 'function'
      ) {
        await jobWithDelay.moveToDelayed(Date.now() + withJitter(retryAfterMs, this.jitterMs), jobWithDelay.token);
        throw new DelayedError();
      }

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /**
   * Dead-letter handling. Without this hook, a job that exhausts its retries vanishes
   * from the application's point of view: nothing is logged at the terminal failure, and
   * there is no way to tell a healthy endpoint from one that has been failing for hours.
   *
   * `removeOnFail` in the queue config keeps the last 5000 failures for inspection, so
   * this hook is the signal, not the storage. Failure telemetry (lastError,
   * lastFailureAt, lastStatusCode, consecutiveFailures) is recorded by `process()` on
   * every attempt; this hook only decides whether to announce a retry or a dead-letter,
   * and never touches the user-configured `retryCount` (that column is the retry budget,
   * not an attempt counter).
   */
  @OnWorkerEvent('failed')
  onJobFailed(job: Job<WebhookJobData> | undefined, error: Error): void {
    if (!job) return;

    const { webhookId, event, maxRetries } = job.data;
    const attemptsMade = job.attemptsMade;
    const isExhausted = attemptsMade >= maxRetries;

    if (!isExhausted) {
      this.logger.warn('Webhook delivery failed, retry scheduled', {
        webhookId,
        event,
        jobId: job.id,
        attemptsMade,
        maxRetries,
        action: 'webhook_retry_scheduled',
        error: error.message,
      });
      return;
    }

    this.logger.error(
      `Webhook dead-lettered after ${attemptsMade} attempts; endpoint appears unreachable`,
      error.message,
      {
        webhookId,
        event,
        jobId: job.id,
        attemptsMade,
        maxRetries,
        action: 'webhook_dead_lettered',
      },
    );
  }
}
