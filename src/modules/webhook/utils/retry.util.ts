export function withJitter(delayMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return delayMs;
  const jitter = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
  const d = delayMs + jitter;
  return d < 0 ? 0 : d;
}

export function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const s = h.trim();
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && n >= 0) return n * 1000; // seconds
  // try HTTP-date (simple)
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const diff = d.getTime() - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}
