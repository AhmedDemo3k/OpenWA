import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { Request } from 'express';
import { createHash } from 'crypto';
import { PerApiKeyThrottlerGuard, clientIp, extractApiKey } from './per-api-key-throttler.guard';
import { AuthService } from '../auth.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';

const OPTIONS = {
  throttlers: [
    { ttl: 1000, limit: 10 },
    { ttl: 60_000, limit: 100, name: 'medium' },
  ],
} as unknown as ThrottlerModuleOptions;

const storage = { increment: jest.fn() } as unknown as ThrottlerStorage;
const reflector = {
  getAllAndOverride: jest.fn().mockReturnValue(undefined),
} as unknown as Reflector;

function makeRequest(headers: Record<string, string>, ip = '127.0.0.1'): Request {
  return {
    headers,
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function makeContext(request: Request): ExecutionContext {
  // The throttler writes X-RateLimit-* onto the response, so the HTTP context needs one.
  const response = {
    setHeader: jest.fn(),
    getHeader: jest.fn(),
    getStatusCode: () => 200,
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    json: jest.fn(),
  };

  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

/** Reaches the protected tracker, which is what the throttler actually calls. */
async function trackerFor(guard: PerApiKeyThrottlerGuard, request: Request): Promise<string> {
  return (guard as unknown as { getTracker(req: Record<string, unknown>): Promise<string> }).getTracker(request);
}

function authServiceWith(getRateLimit: jest.Mock): AuthService {
  return { getRateLimit } as unknown as AuthService;
}

describe('extractApiKey', () => {
  it('reads the X-API-Key header', () => {
    expect(extractApiKey(makeRequest({ 'x-api-key': 'abc' }))).toBe('abc');
  });

  it('reads an Authorization bearer token', () => {
    expect(extractApiKey(makeRequest({ authorization: 'Bearer xyz' }))).toBe('xyz');
  });

  it('ignores a non-bearer Authorization header', () => {
    expect(extractApiKey(makeRequest({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeUndefined();
  });

  it('prefers X-API-Key when both are present, matching ApiKeyGuard', () => {
    expect(extractApiKey(makeRequest({ 'x-api-key': 'from-header', authorization: 'Bearer from-auth' }))).toBe(
      'from-header',
    );
  });

  it('returns undefined when no key is presented', () => {
    expect(extractApiKey(makeRequest({}))).toBeUndefined();
  });
});

describe('clientIp', () => {
  it('takes the left-most X-Forwarded-For entry', () => {
    // Tailscale funnel rewrites the request, so req.ip is the local tailnet address and the
    // forwarded header is the only place the real caller appears.
    expect(clientIp(makeRequest({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18' }))).toBe('203.0.113.9');
  });

  it('falls back to the socket address', () => {
    expect(clientIp(makeRequest({}, '10.0.0.5'))).toBe('10.0.0.5');
  });
});

describe('PerApiKeyThrottlerGuard.getTracker', () => {
  let guard: PerApiKeyThrottlerGuard;

  beforeEach(() => {
    guard = new PerApiKeyThrottlerGuard(
      OPTIONS,
      storage,
      reflector,
      authServiceWith(jest.fn().mockResolvedValue(null)),
    );
  });

  it('buckets by the SHA-256 of the key, never the key itself', async () => {
    const tracker = await trackerFor(guard, makeRequest({ 'x-api-key': 'owa_k1_secret' }));

    expect(tracker).toBe(`key:${createHash('sha256').update('owa_k1_secret').digest('hex')}`);
    expect(tracker).not.toContain('owa_k1_secret');
  });

  it('gives two different keys two different buckets', async () => {
    const first = await trackerFor(guard, makeRequest({ 'x-api-key': 'key-one' }));
    const second = await trackerFor(guard, makeRequest({ 'x-api-key': 'key-two' }));

    expect(first).not.toBe(second);
  });

  it('gives the same key one bucket regardless of which header carried it', async () => {
    const viaHeader = await trackerFor(guard, makeRequest({ 'x-api-key': 'same-key' }));
    const viaAuth = await trackerFor(guard, makeRequest({ authorization: 'Bearer same-key' }));

    expect(viaHeader).toBe(viaAuth);
  });

  it('falls back to the address when no key is presented', async () => {
    // Unauthenticated requests still need a bucket or a flood would find no limiter at
    // all, even though ApiKeyGuard rejects them moments later.
    expect(await trackerFor(guard, makeRequest({}))).toBe('ip:127.0.0.1');
  });

  it('gives two callers behind the same address separate buckets once they present keys', async () => {
    // This is the case the whole change exists for: behind the funnel every request arrives
    // from one address, so an address-keyed bucket throttled unrelated clients together.
    const first = await trackerFor(guard, makeRequest({ 'x-api-key': 'a' }, '100.71.167.27'));
    const second = await trackerFor(guard, makeRequest({ 'x-api-key': 'b' }, '100.71.167.27'));

    expect(first).not.toBe(second);
  });
});

describe('PerApiKeyThrottlerGuard per-key limits', () => {
  let storageIncrement: jest.Mock;

  beforeEach(() => {
    storageIncrement = jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60_000,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    reflector.getAllAndOverride = jest.fn().mockReturnValue(undefined);
  });

  // `throttlers` is built in onModuleInit rather than the constructor, so it has to be
  // run before canActivate, the same way Nest does it.
  const guardWith = async (getRateLimit: jest.Mock): Promise<PerApiKeyThrottlerGuard> => {
    const guard = new PerApiKeyThrottlerGuard(
      OPTIONS,
      { increment: storageIncrement },
      reflector,
      authServiceWith(getRateLimit),
    );
    await guard.onModuleInit();
    return guard;
  };

  /** Reads back the limits the guard actually applied. Storage takes (key, ttl, limit, ...). */
  const appliedLimits = (): Array<{ limit: number; ttl: number }> =>
    (storageIncrement.mock.calls as unknown as Array<unknown[]>).map(args => ({
      limit: args[2] as number,
      ttl: args[1] as number,
    }));

  it('keeps the global tiers when the key has no override', async () => {
    const guard = await guardWith(jest.fn().mockResolvedValue(null));

    await guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'unlimited' })));

    expect(appliedLimits()).toEqual([
      { limit: 10, ttl: 1000 },
      { limit: 100, ttl: 60_000 },
    ]);
  });

  it('replaces the tiers with the key quota when one is set', async () => {
    const guard = await guardWith(jest.fn().mockResolvedValue({ limit: 5, ttlMs: 60_000 }));

    await guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'throttled' })));

    expect(appliedLimits()).toEqual([{ limit: 5, ttl: 60_000 }]);
  });

  it('restores the configured tiers after an overridden request', async () => {
    const guard = await guardWith(jest.fn().mockResolvedValue({ limit: 5, ttlMs: 60_000 }));

    await guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'throttled' })));
    await guard.canActivate(makeContext(makeRequest({})));

    // Without the restore, the second request would still be held to the first key's quota.
    expect(appliedLimits().slice(1)).toEqual([
      { limit: 10, ttl: 1000 },
      { limit: 100, ttl: 60_000 },
    ]);
  });

  it('reads the row once per key rather than on every request', async () => {
    const getRateLimit = jest.fn().mockResolvedValue(null);
    const guard = await guardWith(getRateLimit);

    const request = makeRequest({ 'x-api-key': 'repeated' });
    await guard.canActivate(makeContext(request));
    await guard.canActivate(makeContext(request));
    await guard.canActivate(makeContext(request));

    expect(getRateLimit).toHaveBeenCalledTimes(1);
  });

  it('re-reads the row after the cache expires', async () => {
    jest.useFakeTimers();
    try {
      const getRateLimit = jest.fn().mockResolvedValue(null);
      const guard = await guardWith(getRateLimit);
      const request = makeRequest({ 'x-api-key': 'expiring' });

      await guard.canActivate(makeContext(request));
      jest.advanceTimersByTime(61_000);
      await guard.canActivate(makeContext(request));

      expect(getRateLimit).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('picks up a changed limit as soon as the cache is invalidated', async () => {
    const getRateLimit = jest
      .fn()
      .mockResolvedValueOnce({ limit: 5, ttlMs: 60_000 })
      .mockResolvedValueOnce({ limit: 50, ttlMs: 60_000 });
    const guard = await guardWith(getRateLimit);

    await guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'edited' })));
    guard.invalidateLimit('edited');
    await guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'edited' })));

    expect(appliedLimits()).toEqual([
      { limit: 5, ttl: 60_000 },
      { limit: 50, ttl: 60_000 },
    ]);
  });

  it('falls back to the global tiers when the lookup throws', async () => {
    const guard = await guardWith(jest.fn().mockRejectedValue(new Error('database is locked')));

    await expect(guard.canActivate(makeContext(makeRequest({ 'x-api-key': 'broken' })))).resolves.toBe(true);
    expect(appliedLimits()).toEqual([
      { limit: 10, ttl: 1000 },
      { limit: 100, ttl: 60_000 },
    ]);
  });

  it('does not look up a rate limit when no key is presented', async () => {
    const getRateLimit = jest.fn();
    const guard = await guardWith(getRateLimit);

    await guard.canActivate(makeContext(makeRequest({})));

    expect(getRateLimit).not.toHaveBeenCalled();
  });
});

describe('ApiKey rate limit fields', () => {
  it('are null by default so existing keys inherit the global limits', () => {
    // Mirrors the entity's column defaults. A key created before this field existed must
    // not silently start with a limit of zero, which would block it entirely.
    const key: Partial<ApiKey> = { rateLimit: null, rateLimitWindowSeconds: null };
    expect(key.rateLimit).toBeNull();
    expect(key.rateLimitWindowSeconds).toBeNull();
    expect(ApiKeyRole.ADMIN).toBe('admin');
  });
});
