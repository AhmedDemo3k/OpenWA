import { randomUUID, createHmac, timingSafeEqual } from 'crypto';

export function generateNonce(): string {
  return randomUUID();
}

/**
 * Attach a timestamp (`t`, unix seconds) and a single-use `nonce` to a payload. Both are
 * covered by the HMAC signature, so a receiver can reject replays by checking the clock
 * skew against `t` and that the `nonce` has not been seen within the tolerance window.
 */
export function buildSignedPayload(
  base: Record<string, unknown>,
  nonce: string,
  now: number = Date.now(),
): Record<string, unknown> {
  return { ...base, t: Math.floor(now / 1000), nonce };
}

export function computeSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Constant-time verification of an `X-OpenWA-Signature` header value.
 */
export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = computeSignature(body, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reject a signed payload whose timestamp is older/newer than `toleranceSeconds`, or that
 * lacks the `t`/`nonce` fields entirely.
 */
export function isWithinTolerance(t: unknown, toleranceSeconds: number, now: number = Date.now()): boolean {
  if (typeof t !== 'number' || !Number.isFinite(t)) return false;
  const skew = Math.abs(Math.floor(now / 1000) - t);
  return skew <= toleranceSeconds;
}
