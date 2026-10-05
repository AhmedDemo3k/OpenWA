import { KeyedMutex } from './keyed-mutex.util';

describe('KeyedMutex', () => {
  it('serialises operations that share a key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const task = (name: string, delay: number) =>
      mutex.withLock('session-1', async () => {
        order.push(`${name}:start`);
        await new Promise(r => setTimeout(r, delay));
        order.push(`${name}:end`);
        return name;
      });

    const results = await Promise.all([task('a', 30), task('b', 1), task('c', 1)]);

    expect(results).toEqual(['a', 'b', 'c']);
    // No interleaving: each task must fully finish before the next begins.
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      ['s1', 's2', 's3'].map(key =>
        mutex.withLock(key, async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise(r => setTimeout(r, 20));
          concurrent--;
        }),
      ),
    );

    expect(peak).toBe(3);
  });

  it('releases the lock when the task throws, and does not poison the queue', async () => {
    const mutex = new KeyedMutex();

    const failing = mutex.withLock('k', () => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');

    // A later operation on the same key must still run.
    await expect(mutex.withLock('k', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('continues the queue after a failure instead of skipping waiters', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = mutex.withLock('k', () => {
      order.push('first');
      return Promise.reject(new Error('first fails'));
    });
    const second = mutex.withLock('k', () => {
      order.push('second');
      return Promise.resolve();
    });
    const third = mutex.withLock('k', () => {
      order.push('third');
      return Promise.resolve();
    });

    await expect(first).rejects.toThrow('first fails');
    await Promise.all([second, third]);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('does not leak map entries once idle', async () => {
    const mutex = new KeyedMutex();

    await mutex.withLock('a', () => Promise.resolve());
    await mutex.withLock('b', () => Promise.resolve());

    expect(mutex.size).toBe(0);
  });

  it('drain() waits for in-flight work', async () => {
    const mutex = new KeyedMutex();
    let finished = false;

    const running = mutex.withLock('slow', async () => {
      await new Promise(r => setTimeout(r, 60));
      finished = true;
    });

    await mutex.drain();
    expect(finished).toBe(true);
    await running;
  });
});
