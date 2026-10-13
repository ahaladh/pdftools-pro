/** Serialises async work per key within one process (e.g. quota check + reservation per owner). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try { return await next; }
    finally { if (this.tails.get(key) === next) this.tails.delete(key); }
  }
}
