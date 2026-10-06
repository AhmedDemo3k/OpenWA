import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { Message, MessageStatus } from './entities/message.entity';
import { MessageService } from './message.service';

/**
 * Background delivery for messages persisted with a future `sendAt`.
 *
 * Polls the database rather than holding one timer per message: restarted news of the API
 * goes through a database that already has the message, so a process restart cannot lose a
 * scheduled send the way an in-memory setTimeout would. The polling interval is short
 * relative to the granularity anyone schedules at, and the query is covered by the
 * (status, sendAt) index.
 *
 * Concurrency across restarts is handled with a compare-and-swap claim: a due row is moved
 * scheduled -> sending before delivery, and only the instance that owns that transition
 * sends it. Rows left in `sending` by a hard crash are reset on boot, because the watchdog
 * is supervised to be the only process alive.
 */
@Injectable()
export class ScheduledMessageDispatcher implements OnModuleInit, OnModuleDestroy {
  private static readonly TICK_MS = 5000;
  private static readonly BATCH_SIZE = 50;

  private readonly logger = new Logger('ScheduledMessageDispatcher');
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly messageService: MessageService,
  ) {}

  async onModuleInit(): Promise<void> {
    // A crashed instance can leave rows claimed as 'sending'. Reset them before the first
    // sweep so those messages are not lost; both steps swallow their own errors.
    await this.resetStaleClaims();
    await this.dispatchDue();

    this.timer = setInterval(() => {
      void this.dispatchDue();
    }, ScheduledMessageDispatcher.TICK_MS);
    // unref keeps the event loop from staying alive purely for this timer, so a serving
    // instance can shut down cleanly.
    (this.timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
  }

  onModuleDestroy(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async resetStaleClaims(): Promise<void> {
    try {
      // Anything still claimed as `sending` at boot was left behind by a crash.
      // Requeue it so it is not silently lost.
      const result = await this.messageRepository.update(
        { status: MessageStatus.SENDING },
        { status: MessageStatus.SCHEDULED },
      );
      if (result.affected) {
        this.logger.warn(`reset ${result.affected} stale scheduled-message claim(s) after restart`);
      }
    } catch (error) {
      this.logger.error(
        `failed to reset stale scheduled-message claims: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async dispatchDue(): Promise<void> {
    if (this.closed) return;

    try {
      const due = await this.messageRepository.find({
        where: {
          status: MessageStatus.SCHEDULED,
          sendAt: LessThanOrEqual(new Date()),
        },
        order: { sendAt: 'ASC' },
        take: ScheduledMessageDispatcher.BATCH_SIZE,
      });

      for (const message of due) {
        if (this.closed) return;

        const claimed = await this.messageRepository.update(
          { id: message.id, status: MessageStatus.SCHEDULED },
          { status: MessageStatus.SENDING },
        );
        // affected === 0 means another instance already claimed and delivered it.
        if (!claimed.affected) {
          continue;
        }

        try {
          await this.messageService.deliverMessage(message);
        } catch (error) {
          // deliverMessage marks the row failed itself; all that is left is to explain.
          this.logger.error(
            `scheduled message ${message.id} delivery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`scheduled-message sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
