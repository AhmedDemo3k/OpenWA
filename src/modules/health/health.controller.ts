import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { CacheService } from '../../common/cache/cache.service';

type ProbeStatus = 'up' | 'down' | 'disabled' | 'degraded';

interface ProbeResult {
  status: ProbeStatus;
  latencyMs?: number;
  error?: string;
}

interface HealthCheckResult {
  status: 'ok' | 'error';
  info?: Record<string, unknown>;
  error?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

/**
 * Probes a dependency with a hard timeout.
 *
 * The timeout matters as much as the probe: a wedged socket can leave a `SELECT 1`
 * pending indefinitely, and an orchestrator health check that hangs is worse than one
 * that fails, because it never gets a chance to restart the container.
 */
async function probe(
  name: string,
  task: () => Promise<unknown>,
  timeoutMs = 3000,
): Promise<{ name: string } & ProbeResult> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    return { name, status: 'up', latencyMs: Date.now() - start };
  } catch (error: unknown) {
    return {
      name,
      status: 'down',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    @InjectDataSource('main') private readonly mainDataSource: DataSource,
    @InjectDataSource('data') private readonly dataDataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Liveness: the process is up and the event loop still turns.
   *
   * This must stay dependency-free. If liveness checked the database, a transient DB
   * outage would make the orchestrator kill and restart every replica simultaneously,
   * turning a recoverable blip into a full outage.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness check (no dependency checks)' })
  @ApiResponse({ status: 200, description: 'Application is alive' })
  check(): { status: string; timestamp: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe for Kubernetes' })
  @ApiResponse({ status: 200, description: 'Application is alive' })
  liveness(): { status: string; timestamp: string; uptimeSeconds: number } {
    return this.check();
  }

  /**
   * Readiness: can this instance actually serve traffic?
   *
   * Previously this returned a hardcoded `database: { status: 'up' }` while injecting no
   * dependencies at all, so it reported healthy even with the database unreachable. The
   * healthcheck URL was in turn pointed at this endpoint, so a wedged process was never
   * detected and would never be restarted.
   *
   * Redis is reported but never fails the check: the cache is an optional accelerator and
   * the gateway is fully functional without it.
   *
   * This endpoint is load-bearing — `Dockerfile`, both compose files and `watchdog.js` all
   * poll `/api/health/ready` and act on the status code. If the route moves, all of them
   * must be updated, and `test/app.e2e-spec.ts` guards the path.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe with real dependency checks' })
  @ApiResponse({ status: 200, description: 'Application is ready to accept traffic' })
  @ApiResponse({ status: 503, description: 'A required dependency is unavailable' })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<HealthCheckResult> {
    const [main, data, redis] = await Promise.all([
      probe('database_main', async () => {
        if (!this.mainDataSource.isInitialized) throw new Error('not initialized');
        await this.mainDataSource.query('SELECT 1');
      }),
      probe('database_data', async () => {
        if (!this.dataDataSource.isInitialized) throw new Error('not initialized');
        await this.dataDataSource.query('SELECT 1');
      }),
      probe('redis', async () => {
        const available = await this.cacheService.isAvailable();
        if (!available) throw new Error('cache unavailable or disabled');
      }),
    ]);

    const details: Record<string, ProbeResult> = {
      database_main: main,
      database_data: data,
      redis,
    };

    const required = [main, data];
    const healthy = required.every(r => r.status === 'up');
    const degraded = healthy && redis.status !== 'up';

    if (!healthy) {
      // A real 503, not just `status: 'error'` in a 200 body: the healthcheck and the
      // watchdog both read the status code, so a 200 would let them treat a broken
      // instance as healthy and never restart it.
      res.status(503);
    }

    return {
      status: healthy ? 'ok' : 'error',
      details: {
        ...details,
        // Reported separately so an optional dependency being down is visible without
        // making the instance look unready.
        degraded,
      },
      ...(healthy ? {} : { error: details }),
    };
  }
}
