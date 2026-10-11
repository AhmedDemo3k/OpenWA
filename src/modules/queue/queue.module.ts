import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookProcessor } from './processors/webhook.processor';
import { QUEUE_NAMES } from './queue-names';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookDeliveryLog } from '../webhook/entities/webhook-delivery-log.entity';
import { HooksModule } from '../../core/hooks/hooks.module';

// Re-export for backward compatibility
export { QUEUE_NAMES } from './queue-names';

@Module({
  imports: [
    // Required for WebhookProcessor to inject Repository<Webhook> and the delivery log
    TypeOrmModule.forFeature([Webhook, WebhookDeliveryLog], 'data'),
    // Required for WebhookProcessor to inject HookManager
    HooksModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host', 'localhost'),
          port: configService.get<number>('redis.port', 6379),
          password: configService.get<string>('redis.password'),
          // Bounded reconnects. BullMQ needs this to be finite: with ioredis defaults a
          // dead Redis leaves a worker alive forever, retrying silently and never
          // surfacing as unhealthy.
          maxRetriesPerRequest: 3,
          enableOfflineQueue: false,
          retryStrategy: (times: number): number => Math.min(times * 500, 10_000),
        },
      }),
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.WEBHOOK,
      // Without explicit retention BullMQ keeps every completed *and* failed job in Redis
      // forever. On a busy gateway that is an unbounded memory leak in the one component
      // designed to run indefinitely. Keep a bounded window of each: recent completions
      // for debugging, and recent failures as a de-facto dead-letter queue.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000, age: 3600 },
        removeOnFail: { count: 5000, age: 86_400 },
      },
    }),

    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.WEBHOOK,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [WebhookProcessor],
  exports: [BullModule],
})
export class QueueModule {}
