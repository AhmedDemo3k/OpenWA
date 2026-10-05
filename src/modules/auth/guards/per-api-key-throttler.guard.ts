import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { Request } from 'express';
import { AuthService } from '../auth.service';

/**
 * A per-key rate limit, as stored on the `api_keys` row.
 */
export interface PerKeyLimit {
  limit: number;
  ttlMs: number;
}

/**
 * Rate limiting scoped to the API key rather than the caller's address.
 *
 * `ThrottlerGuard` buckets on `req.ip`, and behind a reverse proxy that is the proxy's
 * address. This instance is fronted by a Tailscale funnel, so every request arrived from
 * the same host address and a single chatty client exhausted the quota for all the others
 * -- one client's 429s took down everyone else's bot traffic. Bucketing on the key gives
 * each caller its own counter.
 *
 * Two details worth keeping:
 *
 * - The tracker is the key's SHA-256, not the key. The tracker string becomes part of the
 *   storage key, and with Redis enabled that means the raw secret would be sitting in a
 *   shared cache. The digest is the same value already stored in `api_keys.keyHash`.
 * - Requests without a key still fall back to the address. They will be rejected by
 *   ApiKeyGuard a moment later, but they need a bucket, or a flood of unauthenticated
 *   requests would find no limiter at all.
 *
 * The guard reads the raw header rather than `req.apiKey`, because it is registered ahead
 * of ApiKeyGuard and so runs before any key has been validated.
 */
@Injectable()
export class PerApiKeyThrottlerGuard extends ThrottlerGuard {
  /**
   * Resolved per-key limits, memoised on the key hash.
   *
   * Without this the guard would query `api_keys` on every request, ahead of the lookup
   * AuthService already performs during validation. The TTL is short enough that editing a
   * key's limit takes effect on its own, which matters more here than shaving a query,
   * since this instance is a single local SQLite database with a handful of callers.
   */
  private readonly limitCache = new Map<string, { limit: PerKeyLimit | null; expiresAt: number }>();

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly authService: AuthService,
  ) {
    super(options, storageService, reflector);
  }

  /** How long a resolved per-key limit is reused before the row is read again. */
  private static readonly CACHE_TTL_MS = 60_000;

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request;
    const rawKey = extractApiKey(request);

    if (!rawKey) {
      return Promise.resolve(`ip:${clientIp(request)}`);
    }

    return Promise.resolve(`key:${sha256(rawKey)}`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const override = await this.resolveLimit(context);

    if (!override) {
      return super.canActivate(context);
    }

    // An explicit per-key quota replaces the global tiers rather than adding to them.
    // Both together would be ambiguous: a key asking for 600/min would still be cut off
    // by the global 10/second burst tier, and there would be no way to tell which limit
    // produced the 429.
    const configured = this.throttlers;
    this.throttlers = [{ ...configured[0], limit: override.limit, ttl: override.ttlMs }];
    try {
      return await super.canActivate(context);
    } finally {
      this.throttlers = configured;
    }
  }

  /** Drops the memoised limit for a key so an edit takes effect immediately. */
  invalidateLimit(rawKeyOrHash: string): void {
    const hash = rawKeyOrHash.startsWith('key:') ? rawKeyOrHash.slice(4) : sha256(rawKeyOrHash);
    this.limitCache.delete(hash);
  }

  private async resolveLimit(context: ExecutionContext): Promise<PerKeyLimit | null> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawKey = extractApiKey(request);
    if (!rawKey) {
      return null;
    }

    const hash = sha256(rawKey);
    const cached = this.limitCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.limit;
    }

    let limit: PerKeyLimit | null;
    try {
      limit = await this.authService.getRateLimit(rawKey);
    } catch {
      // An unreadable row must not take the API down: fall back to the global limits.
      limit = null;
    }

    this.limitCache.set(hash, { limit, expiresAt: Date.now() + PerApiKeyThrottlerGuard.CACHE_TTL_MS });
    return limit;
  }
}

/**
 * Reads the presented key from either supported header. Mirrors ApiKeyGuard so the two
 * agree on which requests are keyed and which fall back to the address.
 */
export function extractApiKey(request: Request): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }

  const authorization = request.headers['authorization'];
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7);
  }

  return undefined;
}

/**
 * The caller's address, honouring X-Forwarded-For.
 *
 * Tailscale funnel forwards the original client, so the left-most entry is the real caller.
 * Express also needs `trust proxy` for `req.ip` to do this, and that is not set.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  const asArray = Array.isArray(forwarded) ? forwarded[0] : undefined;
  if (typeof asArray === 'string' && asArray.length > 0) {
    return asArray.split(',')[0].trim();
  }

  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
