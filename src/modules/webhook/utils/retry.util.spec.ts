import { withJitter, parseRetryAfter } from './retry.util';

describe('withJitter', () => {
  it('returns the base delay unchanged when jitter is disabled', () => {
    expect(withJitter(1000, 0)).toBe(1000);
  });

  it('applies jitter within +/- jitterMs', () => {
    for (let i = 0; i < 50; i++) {
      const d = withJitter(1000, 250);
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });

  it('never returns a negative delay', () => {
    for (let i = 0; i < 50; i++) {
      expect(withJitter(100, 500)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseRetryAfter', () => {
  it('parses a delta-seconds value into milliseconds', () => {
    expect(parseRetryAfter('12')).toBe(12000);
  });

  it('returns null for missing/garbage input', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
  });

  it('parses an HTTP-date into a positive delay', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).not.toBeNull();
    expect(parsed as number).toBeGreaterThan(0);
  });

  it('returns null for a past HTTP-date', () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });
});
