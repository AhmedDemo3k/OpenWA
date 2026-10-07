import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiUsage } from './entities/api-usage.entity';

/**
 * Counts API requests per calendar day.
 *
 * Requests are accumulated in memory and flushed to the `api_usage` table on an interval,
 * because writing a row per request would flood the database. A small window of unflushed
 * requests is lost if the process dies, which is an acceptable trade-off for a dashboard
 * counter. The counter is "today" (server-local calendar date), matching how the stats
 * module buckets message activity with `setHours(0,0,0,0)`.
 */
@Injectable()
export class ApiUsageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ApiUsageService');
  private readonly pending = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(ApiUsage, 'data')
    private readonly usageRepository: Repository<ApiUsage>,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 60_000);
    this.flushTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Records one API request against the current day's bucket. */
  increment(): void {
    const today = this.keyFor(new Date());
    this.pending.set(today, (this.pending.get(today) ?? 0) + 1);
  }

  /** Persisted count for today plus anything not yet flushed. */
  async getTodayCount(): Promise<number> {
    const today = this.keyFor(new Date());
    let persisted = 0;
    try {
      const row = await this.usageRepository.findOne({ where: { date: today } });
      persisted = row?.requests ?? 0;
    } catch (error) {
      // A counter must never take the stats endpoint down; best-effort read.
      this.logger.warn(`Api usage read failed (${today}): ${String(error)}`);
    }
    return persisted + (this.pending.get(today) ?? 0);
  }

  private keyFor(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async flush(): Promise<void> {
    // A key is only removed after its write succeeds, so a transient failure rolls back
    // into the pending map for the next flush tick.
    for (const [date, requests] of Array.from(this.pending.entries())) {
      try {
        await this.upsert(date, requests);
        this.pending.delete(date);
      } catch (error) {
        this.logger.warn(`Api usage flush failed for ${date}: ${String(error)}`);
      }
    }
  }

  private async upsert(date: string, delta: number): Promise<void> {
    const existing = await this.usageRepository.findOne({ where: { date } });
    if (existing) {
      // Raw increment so concurrent flushes cannot lose counts.
      await this.usageRepository.update(existing.id, {
        requests: () => `"requests" + ${delta}`,
      });
    } else {
      await this.usageRepository.insert({ date, requests: delta });
    }
  }
}
