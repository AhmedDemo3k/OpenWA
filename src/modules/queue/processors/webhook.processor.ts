import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { WebhookJobData } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
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

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
  ) {
    super();
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
        // Drain the body so undici can release the socket back to the pool instead of
        // holding it until GC. A slow-to-read error response would otherwise accumulate
        // open connections across retries.
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await response.body?.cancel().catch(() => undefined);

      // Update lastTriggeredAt on successful delivery.
      // Deliberately NOT allowed to fail the job: the endpoint already received the
      // payload, so throwing here would make BullMQ redeliver a message that was in fact
      // delivered, producing duplicates for the consumer.
      await this.webhookRepository.update(webhookId, { lastTriggeredAt: new Date() }).catch((error: unknown) => {
        this.logger.warn('Failed to record webhook delivery timestamp', {
          webhookId,
          action: 'webhook_touch_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // Execute hook after successful delivery
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

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /**
   * Dead-letter handling. Without this hook, a job that exhausts its retries vanishes
   * from the application's point of view: nothing is logged at the terminal failure, the
   * webhook's `retryCount` column is never updated, and there is no way to tell a
   * healthy endpoint from one that has been failing for hours.
   *
   * `removeOnFail` in the queue config keeps the last 5000 failures for inspection, so
   * this hook is the signal, not the storage.
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<WebhookJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;

    const { webhookId, event, maxRetries } = job.data;
    const attemptsMade = job.attemptsMade;
    const isExhausted = attemptsMade >= maxRetries;

    // Record the real attempt count so operators can see failure history per endpoint.
    await this.webhookRepository.update(webhookId, { retryCount: attemptsMade }).catch((updateError: unknown) => {
      this.logger.warn('Failed to record webhook retry count', {
        webhookId,
        action: 'webhook_retry_count_failed',
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    });

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
