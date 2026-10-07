import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ApiUsageService } from './api-usage.service';

/**
 * Increments the per-day API request counter on every controller route.
 *
 * Registered as a global APP_INTERCEPTOR, so it sees every request that reaches a Nest
 * handler (static assets and SPA fallback are served by middleware and do not count as
 * API calls).
 */
@Injectable()
export class ApiUsageInterceptor implements NestInterceptor {
  constructor(private readonly apiUsageService: ApiUsageService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    this.apiUsageService.increment();
    return next.handle();
  }
}
