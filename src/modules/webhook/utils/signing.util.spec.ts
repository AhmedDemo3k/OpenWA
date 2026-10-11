import {
  computeSignature,
  verifySignature,
  buildSignedPayload,
  generateNonce,
  isWithinTolerance,
} from './signing.util';

describe('signing.util', () => {
  const secret = 'top-secret';

  it('computes a stable sha256 HMAC signature', () => {
    const a = computeSignature('{"a":1}', secret);
    const b = computeSignature('{"a":1}', secret);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('verifies a correct signature and rejects a tampered one', () => {
    const sig = computeSignature('payload', secret);
    expect(verifySignature('payload', secret, sig)).toBe(true);
    expect(verifySignature('payload-x', secret, sig)).toBe(false);
    expect(verifySignature('payload', 'wrong-secret', sig)).toBe(false);
  });

  it('returns false for a signature of a different length (no throw)', () => {
    expect(verifySignature('payload', secret, 'short')).toBe(false);
  });

  it('builds a payload carrying a timestamp and nonce', () => {
    const nonce = generateNonce();
    const now = Date.UTC(2026, 0, 1);
    const signed = buildSignedPayload({ hello: 'world' }, nonce, now);
    expect(signed).toMatchObject({ hello: 'world', nonce, t: Math.floor(now / 1000) });
  });

  it('generates unique nonces', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it('checks timestamp tolerance', () => {
    const now = Date.UTC(2026, 0, 1);
    const t = Math.floor(now / 1000);
    expect(isWithinTolerance(t, 300, now)).toBe(true);
    expect(isWithinTolerance(t - 301, 300, now)).toBe(false);
    expect(isWithinTolerance('nope', 300, now)).toBe(false);
  });
});
