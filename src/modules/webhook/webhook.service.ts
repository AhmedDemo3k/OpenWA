import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import * as crypto from 'crypto';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryLog } from './entities/webhook-delivery-log.entity';
import { WebhookNonce } from './entities/webhook-nonce.entity';
import { CreateWebhookDto, UpdateWebhookDto, WebhookDeliveryDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { recordDeliveryOutcome } from './utils/delivery-stats.util';
import { HookManager } from '../../core/hooks';
import { validateWebhookUrl } from './utils/url-validator.util';
import { extractErrorBody, truncateErrorBody } from './utils/error-body.util';
import { parseRetryAfter, withJitter } from './utils/retry.util';
import { SimpleRateLimiter } from './utils/rate-limiter.util';
import { generateNonce, buildSignedPayload } from './utils/signing.util';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookJobData {
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  signature: string;
  headers: Record<string, string>;
  attempt: number;
  maxRetries: number;
}

@Injectable()
export class WebhookService {
  private readonly logger = createLogger('WebhookService');
  private readonly queueEnabled: boolean;

  private readonly rlPerWebhook: SimpleRateLimiter;
  private readonly cbFailures: number;
  private readonly cbCooldown: number;
  private readonly maxErrorBodyChars: number;
  private readonly respectRetryAfter: boolean;
  private readonly jitterMs: number;
  private readonly replayProtection: boolean;
  private readonly replayTtlMs: number;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryLog, 'data')
    private readonly deliveryLogRepo: Repository<WebhookDeliveryLog>,
    @InjectRepository(WebhookNonce, 'data')
    private readonly nonceRepo: Repository<WebhookNonce>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    this.queueEnabled = configService.get<boolean>('queue.enabled', false);
    this.rlPerWebhook = new SimpleRateLimiter(60_000, 60);
    this.cbFailures = this.configService.get<number>('webhook.circuitBreakerFailures', 10);
    this.cbCooldown = this.configService.get<number>('webhook.circuitBreakerCooldownMs', 300_000);
    this.maxErrorBodyChars = this.configService.get<number>('webhook.maxErrorBodyChars', 200);
    this.respectRetryAfter = this.configService.get<boolean>('webhook.respectRetryAfter', true);
    this.jitterMs = this.configService.get<number>('webhook.jitterMs', 1000);
    this.replayProtection = this.configService.get<boolean>('webhook.enableReplayProtection', false);
    this.replayTtlMs = this.configService.get<number>('webhook.replayTtlMs', 300_000);
  }

  private checkCircuit(webhook: Webhook): void {
    if (webhook.paused) {
      const cooldown = this.cbCooldown;
      if (webhook.pausedAt && Date.now() - new Date(webhook.pausedAt).getTime() < cooldown) {
        throw new BadRequestException(`Webhook is paused: ${webhook.pauseReason || 'circuit breaker'}`);
      }
      // auto-unpause after cooldown? keep manual for safety; but allow if expired? skip hard block
    }
  }

  private async maybeTripCircuit(webhook: Webhook): Promise<void> {
    const failures = (webhook.consecutiveFailures || 0) + 1;
    if (failures >= this.cbFailures && !webhook.paused) {
      webhook.paused = true;
      webhook.pausedAt = new Date();
      webhook.pauseReason = `Circuit breaker: ${failures} consecutive failures`;
      await this.webhookRepository.save(webhook);
      this.logger.warn('Webhook paused by circuit breaker', {
        webhookId: webhook.id,
        consecutiveFailures: failures,
        action: 'webhook_paused_circuit',
      });
    }
  }

  private async logDelivery(d: Partial<WebhookDeliveryLog>): Promise<void> {
    try {
      await this.deliveryLogRepo.save(this.deliveryLogRepo.create(d));
    } catch (e) {
      this.logger.warn('Failed to persist webhook delivery log', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Persistent idempotency: has this exact event already been delivered successfully to
   * this webhook? Backed by the delivery-log table so it survives process restarts.
   */
  private async hasSucceeded(webhookId: string, idempotencyKey: string): Promise<boolean> {
    if (!idempotencyKey) return false;
    try {
      const row = await this.deliveryLogRepo.findOne({
        where: { webhookId, idempotencyKey, success: true },
      });
      return !!row;
    } catch {
      return false;
    }
  }

  async listDeliveryLogs(sessionId: string, webhookId: string, limit = 50): Promise<WebhookDeliveryLog[]> {
    await this.findOwned(sessionId, webhookId);
    return this.deliveryLogRepo.find({
      where: { webhookId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async create(sessionId: string, dto: CreateWebhookDto): Promise<Webhook> {
    const allowed = this.configService.get<string[]>('webhook.allowedUrls', []);
    const blockPriv = this.configService.get<boolean>('webhook.blockPrivateIps', true);
    const v = validateWebhookUrl(dto.url, allowed, blockPriv);
    if (!v.ok) throw new BadRequestException(v.reason || 'Invalid webhook URL');

    const webhook = this.webhookRepository.create({
      sessionId,
      url: dto.url,
      events: dto.events || ['message.received'],
      secret: dto.secret || null,
      headers: dto.headers || {},
      retryCount: dto.retryCount ?? 3,
      paused: false,
      pausedAt: null,
      pauseReason: null,
    });

    return this.webhookRepository.save(webhook);
  }

  async findBySession(sessionId: string): Promise<Webhook[]> {
    return this.webhookRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Webhook[]> {
    return this.webhookRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Webhook> {
    const webhook = await this.webhookRepository.findOne({ where: { id } });
    if (!webhook) {
      throw new NotFoundException(`Webhook with id '${id}' not found`);
    }
    return webhook;
  }

  async update(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.findOne(id);

    if (dto.url !== undefined) {
      const allowed = this.configService.get<string[]>('webhook.allowedUrls', []);
      const blockPriv = this.configService.get<boolean>('webhook.blockPrivateIps', true);
      const v = validateWebhookUrl(dto.url, allowed, blockPriv);
      if (!v.ok) throw new BadRequestException(v.reason || 'Invalid webhook URL');
      webhook.url = dto.url;
    }
    if (dto.events !== undefined) webhook.events = dto.events;
    if (dto.secret !== undefined) webhook.secret = dto.secret;
    if (dto.headers !== undefined) webhook.headers = dto.headers;
    if (dto.active !== undefined) webhook.active = dto.active;
    if (dto.retryCount !== undefined) webhook.retryCount = dto.retryCount;
    if (dto.paused !== undefined) {
      webhook.paused = dto.paused;
      if (dto.paused) {
        webhook.pausedAt = webhook.pausedAt ?? new Date();
        webhook.pauseReason = webhook.pauseReason ?? 'Paused manually';
      } else {
        // Resuming clears the circuit-breaker state so a fresh failure count starts.
        webhook.pausedAt = null;
        webhook.pauseReason = null;
      }
    }

    return this.webhookRepository.save(webhook);
  }

  async delete(id: string): Promise<void> {
    const webhook = await this.findOne(id);
    await this.webhookRepository.remove(webhook);
  }

  async test(sessionId: string, webhookId: string): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const webhook = await this.findOne(webhookId);
    this.checkCircuit(webhook);

    const testPayload: WebhookPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      sessionId,
      idempotencyKey: generateIdempotencyKey('test', { webhookId: webhook.id }),
      deliveryId: generateDeliveryId(),
      data: {
        message: 'This is a test webhook from OpenWA',
        webhookId: webhook.id,
        url: webhook.url,
      },
    };

    const body = JSON.stringify(testPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OpenWA-Webhook/1.0.0',
      'X-OpenWA-Event': 'test',
      'X-OpenWA-Idempotency-Key': testPayload.idempotencyKey,
      'X-OpenWA-Delivery-Id': testPayload.deliveryId,
      'X-OpenWA-Retry-Count': '0',
      'X-OpenWA-Webhook-Version': '1',
      ...webhook.headers,
    };

    if (webhook.secret) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
      });

      return {
        success: response.ok,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    const webhooks = await this.webhookRepository.find({
      where: { sessionId, active: true },
    });

    const matchingWebhooks = webhooks.filter(w => w.events.includes(event) || w.events.includes('*'));

    // Generate idempotency key (same for all webhooks receiving this event)
    const idempotencyKey = generateIdempotencyKey(event, { ...data, sessionId });

    // Dispatch to all matching webhooks
    for (const webhook of matchingWebhooks) {
      try {
        this.checkCircuit(webhook);
      } catch {
        this.logger.debug('Skipping webhook due to circuit', { webhookId: webhook.id });
        continue;
      }
      if (!this.rlPerWebhook.check(`wh:${webhook.id}`)) {
        this.logger.warn('Webhook rate limited', { webhookId: webhook.id });
        continue;
      }
      // Persistent idempotency: skip events already delivered successfully.
      if (await this.hasSucceeded(webhook.id, idempotencyKey)) {
        this.logger.debug('Skipping already-delivered webhook event', {
          webhookId: webhook.id,
          idempotencyKey,
        });
        continue;
      }
      // Generate unique delivery ID for each webhook
      const deliveryId = generateDeliveryId();

      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        sessionId,
        idempotencyKey,
        deliveryId,
        data,
      };

      // Execute hook before webhook dispatch - plugins can modify payload
      const { continue: shouldContinue, data: hookResult } = await this.hookManager.execute(
        'webhook:before',
        { sessionId, event, payload },
        { sessionId, source: 'WebhookService' },
      );

      if (!shouldContinue) {
        this.logger.debug(`Webhook dispatch cancelled by plugin for ${event}`, {
          webhookId: webhook.id,
          action: 'webhook_cancelled_by_plugin',
        });
        continue;
      }

      // Use potentially modified payload
      let finalPayload = (hookResult as { payload: WebhookPayload }).payload;

      // Optional replay protection (opt-in): embed a timestamp + single-use nonce in the
      // body so it is covered by the HMAC signature. The nonce is persisted (bounded by a
      // TTL) so receivers can reject replayed deliveries.
      let replayNonce: string | null = null;
      if (this.replayProtection && webhook.secret) {
        const signed = buildSignedPayload(finalPayload as unknown as Record<string, unknown>, generateNonce());
        finalPayload = signed as unknown as WebhookPayload;
        replayNonce = String(signed.nonce);
        await this.nonceRepo
          .save(this.nonceRepo.create({ nonce: replayNonce, expiresAt: Date.now() + this.replayTtlMs }))
          .catch(() => undefined);
      }

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenWA-Webhook/1.0.0',
        'X-OpenWA-Event': event,
        'X-OpenWA-Idempotency-Key': idempotencyKey,
        'X-OpenWA-Delivery-Id': deliveryId,
        'X-OpenWA-Retry-Count': '0',
        'X-OpenWA-Webhook-Version': '1',
        ...(replayNonce ? { 'X-OpenWA-Nonce': replayNonce } : {}),
        ...webhook.headers,
      };

      // Use queue if available, otherwise fallback to direct delivery
      if (this.queueEnabled && this.webhookQueue) {
        const signature = webhook.secret ? this.generateSignature(JSON.stringify(finalPayload), webhook.secret) : '';

        if (webhook.secret) {
          headers['X-OpenWA-Signature'] = signature;
        }

        const jobData: WebhookJobData = {
          webhookId: webhook.id,
          url: webhook.url,
          event,
          payload: finalPayload,
          signature,
          headers,
          attempt: 1,
          maxRetries: webhook.retryCount,
        };

        try {
          await this.webhookQueue.add(`webhook-${webhook.id}`, jobData, {
            attempts: webhook.retryCount,
            backoff: {
              type: 'exponential',
              delay: this.configService.get<number>('webhook.retryDelay', 5000),
            },
          });

          // Execute hook after successful queue (NOT delivery - that happens in processor)
          await this.hookManager.execute(
            'webhook:queued',
            { sessionId, event, webhookId: webhook.id, deliveryId },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.debug(`Webhook job queued for ${webhook.id}`, {
            webhookId: webhook.id,
            event,
            idempotencyKey,
            deliveryId,
            action: 'webhook_queued',
          });
        } catch (error) {
          // Execute hook on queue error (not delivery error - that happens in processor)
          await this.hookManager.execute(
            'webhook:error',
            { sessionId, event, webhookId: webhook.id, error: `Queue failed: ${String(error)}` },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.error(`Failed to queue webhook ${webhook.id}`, String(error), {
            webhookId: webhook.id,
            action: 'webhook_queue_failed',
          });
        }
      } else {
        // Direct delivery when queue is disabled
        try {
          await this.deliverWebhook(webhook, finalPayload, headers);

          // Execute hook after successful delivery
          await this.hookManager.execute(
            'webhook:delivered',
            { sessionId, event, webhookId: webhook.id, deliveryId },
            { sessionId, source: 'WebhookService' },
          );

          // Legacy hook for backward compatibility
          await this.hookManager.execute(
            'webhook:after',
            { sessionId, event, webhookId: webhook.id, success: true },
            { sessionId, source: 'WebhookService' },
          );
        } catch (error) {
          // Execute hook on error
          await this.hookManager.execute(
            'webhook:error',
            { sessionId, event, webhookId: webhook.id, error: String(error) },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
            webhookId: webhook.id,
            action: 'webhook_delivery_failed',
          });
        }
      }
    }
  }

  /**
   * @deprecated Use job queue dispatch instead. This is kept for fallback.
   */
  private async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    headers: Record<string, string>,
    attempt = 1,
  ): Promise<void> {
    const body = JSON.stringify(payload);

    // Update retry count header
    headers['X-OpenWA-Retry-Count'] = String(attempt - 1);

    // Add signature if secret is configured and not already present
    if (webhook.secret && !headers['X-OpenWA-Signature']) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    const startedAt = Date.now();
    let retryAfterMs: number | null = null;
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
      });

      if (!response.ok) {
        // Capture a short, sanitized error body before draining the socket. Many endpoints
        // explain the failure (validation message, rate-limit reason) in the body but not
        // the status line, which is all the DLQ otherwise shows.
        const errBody = await extractErrorBody(response, this.maxErrorBodyChars);
        await response.body?.cancel().catch(() => undefined);
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const suffix = errBody ? ` - ${errBody}` : '';
        const raSuffix = retryAfterMs !== null ? ` [retry-after=${retryAfterMs}ms]` : '';
        throw new Error(`HTTP ${response.status}: ${response.statusText}${suffix}${raSuffix}`);
      }

      await response.body?.cancel().catch(() => undefined);

      // Record delivery telemetry (lastSuccessAt, lastAttemptAt, lastStatusCode,
      // consecutiveFailures reset). This is deliberately best-effort: a row that could
      // not be updated must not be reported to the caller as an undelivered webhook.
      await recordDeliveryOutcome(this.webhookRepository, webhook.id, {
        ok: true,
        at: new Date(),
        statusCode: response.status,
      }).catch((statsError: unknown) => {
        this.logger.warn('Failed to record webhook delivery stats', {
          webhookId: webhook.id,
          action: 'webhook_stats_failed',
          error: statsError instanceof Error ? statsError.message : String(statsError),
        });
      });

      await this.logDelivery({
        webhookId: webhook.id,
        event: payload.event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        success: true,
        statusCode: response.status,
        responseTimeMs: Date.now() - startedAt,
        attempt,
        headers,
        meta: { idempotencyKey: payload.idempotencyKey },
      });

      this.logger.debug(`Webhook delivered to ${webhook.id}`, {
        webhookId: webhook.id,
        deliveryId: payload.deliveryId,
        attempt,
        action: 'webhook_delivered',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.logDelivery({
        webhookId: webhook.id,
        event: payload.event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        success: false,
        statusCode: null,
        error: truncateErrorBody(errorMessage, this.maxErrorBodyChars * 2),
        responseTimeMs: Date.now() - startedAt,
        attempt,
        headers,
        meta: { idempotencyKey: payload.idempotencyKey },
      });

      this.logger.error(`Webhook delivery failed for ${webhook.id}`, errorMessage, {
        webhookId: webhook.id,
        attempt,
        deliveryId: payload.deliveryId,
        action: 'webhook_delivery_failed',
      });

      if (attempt < webhook.retryCount) {
        const baseDelay = this.configService.get<number>('webhook.retryDelay', 5000);
        // Respect an explicit Retry-After when configured; otherwise exponential backoff,
        // matching the queued path: delay, 2x, 4x, ... Both with jitter so a fleet of
        // webhooks does not retry in lockstep.
        const preferred =
          this.respectRetryAfter && retryAfterMs !== null ? retryAfterMs : baseDelay * 2 ** (attempt - 1);
        await this.delay(withJitter(preferred, this.jitterMs));
        return this.deliverWebhook(webhook, payload, headers, attempt + 1);
      }

      // Terminal failure: trip the circuit breaker, then persist the failure telemetry.
      await this.maybeTripCircuit(webhook).catch(() => undefined);

      // Terminal failure: persist the failure telemetry before propagating.
      await recordDeliveryOutcome(this.webhookRepository, webhook.id, {
        ok: false,
        at: new Date(),
        error: errorMessage,
      }).catch(() => undefined);

      throw error;
    }
  }

  /**
   * List dead-lettered (retry-exhausted) deliveries for a webhook from the BullMQ failed
   * set. `removeOnFail` in the queue config retains the last 5000 failures, so this is a
   * bounded, inspectable DLQ without a side database.
   */
  async listDeadLetters(sessionId: string, webhookId: string, limit = 50): Promise<WebhookDeliveryDto[]> {
    const webhook = await this.findOwned(sessionId, webhookId);
    const queue = this.requireQueue();

    const failed = await queue.getFailed(0, Math.max(1, Math.min(limit, 500)) - 1);
    return failed.filter(job => job.name === `webhook-${webhook.id}`).map(job => this.jobToDeliveryDto(job));
  }

  /**
   * Requeue a dead-lettered delivery so it is attempted again from scratch.
   */
  async retryDeadLetter(
    sessionId: string,
    webhookId: string,
    jobId: string,
  ): Promise<{ jobId: string; retried: true }> {
    await this.findOwned(sessionId, webhookId);
    const queue = this.requireQueue();
    const job = await this.findOwnedJob(queue, webhookId, jobId);

    await job.retry();

    this.logger.log(`Requeued dead-lettered webhook delivery`, {
      webhookId,
      jobId: job.id as string,
      action: 'webhook_dlq_retried',
      event: job.data.event,
      deliveryId: job.data.payload.deliveryId,
    });

    return { jobId: job.id as string, retried: true };
  }

  /**
   * Discard a dead-lettered delivery permanently.
   */
  async removeDeadLetter(
    sessionId: string,
    webhookId: string,
    jobId: string,
  ): Promise<{ jobId: string; removed: true }> {
    await this.findOwned(sessionId, webhookId);
    const queue = this.requireQueue();
    const job = await this.findOwnedJob(queue, webhookId, jobId);

    await job.remove();

    this.logger.log(`Discarded dead-lettered webhook delivery`, {
      webhookId,
      jobId: job.id as string,
      action: 'webhook_dlq_removed',
    });

    return { jobId: job.id as string, removed: true };
  }

  /**
   * Requeue every dead-lettered delivery for a webhook. Returns how many were retried and
   * how many were skipped (e.g. a job vanished between listing and retrying).
   */
  async retryAllDeadLetters(
    sessionId: string,
    webhookId: string,
    limit = 200,
  ): Promise<{ retried: number; skipped: number }> {
    const webhook = await this.findOwned(sessionId, webhookId);
    const queue = this.requireQueue();
    const failed = await queue.getFailed(0, Math.max(1, Math.min(limit, 500)) - 1);
    const jobs = failed.filter(job => job.name === `webhook-${webhook.id}`);

    let retried = 0;
    let skipped = 0;
    for (const job of jobs) {
      try {
        await job.retry();
        retried += 1;
      } catch {
        skipped += 1;
      }
    }

    this.logger.log('Requeued dead-lettered webhook deliveries', {
      webhookId,
      action: 'webhook_dlq_retry_all',
      retried,
      skipped,
    });

    return { retried, skipped };
  }

  /**
   * Discard every dead-lettered delivery for a webhook.
   */
  async removeAllDeadLetters(
    sessionId: string,
    webhookId: string,
    limit = 200,
  ): Promise<{ removed: number; skipped: number }> {
    const webhook = await this.findOwned(sessionId, webhookId);
    const queue = this.requireQueue();
    const failed = await queue.getFailed(0, Math.max(1, Math.min(limit, 500)) - 1);
    const jobs = failed.filter(job => job.name === `webhook-${webhook.id}`);

    let removed = 0;
    let skipped = 0;
    for (const job of jobs) {
      try {
        await job.remove();
        removed += 1;
      } catch {
        skipped += 1;
      }
    }

    this.logger.log('Discarded dead-lettered webhook deliveries', {
      webhookId,
      action: 'webhook_dlq_remove_all',
      removed,
      skipped,
    });

    return { removed, skipped };
  }

  private async findOwned(sessionId: string, webhookId: string): Promise<Webhook> {
    const webhook = await this.findOne(webhookId);
    if (webhook.sessionId !== sessionId) {
      // Treat a cross-session reference as not-found rather than leaking existence.
      throw new NotFoundException(`Webhook with id '${webhookId}' not found`);
    }
    return webhook;
  }

  private requireQueue(): Queue<WebhookJobData> {
    if (!this.queueEnabled || !this.webhookQueue) {
      throw new BadRequestException(
        'The BullMQ webhook queue is disabled (queue.enabled=false); dead-letter operations need it',
      );
    }
    return this.webhookQueue;
  }

  private async findOwnedJob(
    queue: Queue<WebhookJobData>,
    webhookId: string,
    jobId: string,
  ): Promise<Job<WebhookJobData>> {
    const job = await queue.getJob(jobId);
    if (!job || job.name !== `webhook-${webhookId}`) {
      throw new NotFoundException(`Dead-lettered delivery '${jobId}' not found for webhook '${webhookId}'`);
    }
    return job;
  }

  private jobToDeliveryDto(job: Job<WebhookJobData>): WebhookDeliveryDto {
    return {
      jobId: job.id as string,
      event: job.data.event,
      deliveryId: job.data.payload.deliveryId,
      attemptsMade: job.attemptsMade ?? 0,
      failedReason: job.failedReason ?? '',
      timestamp: job.timestamp ? new Date(job.timestamp) : null,
      url: job.data.url,
    };
  }

  private generateSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
