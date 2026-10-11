export class SimpleRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private windowMs: number,
    private limit: number,
  ) {}
  check(key: string): boolean {
    const now = Date.now();
    const list = this.hits.get(key) || [];
    const recent = list.filter(ts => now - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
