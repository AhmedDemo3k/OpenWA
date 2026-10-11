import { SimpleRateLimiter } from './rate-limiter.util';

describe('SimpleRateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows hits up to the limit and then rejects', () => {
    const rl = new SimpleRateLimiter(60_000, 3);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
  });

  it('tracks keys independently', () => {
    const rl = new SimpleRateLimiter(60_000, 1);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('b')).toBe(true);
    expect(rl.check('a')).toBe(false);
  });

  it('frees capacity once the window slides', () => {
    const rl = new SimpleRateLimiter(1000, 1);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    jest.setSystemTime(Date.now() + 1001);
    expect(rl.check('a')).toBe(true);
  });
});
