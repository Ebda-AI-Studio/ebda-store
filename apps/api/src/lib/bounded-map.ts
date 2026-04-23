/**
 * A tiny size-bounded Map that drops the oldest entry when it hits the cap.
 * Not true LRU — we don't bump an entry on read — but more than enough to
 * stop an in-memory cache from growing forever. Uses Map's insertion-order
 * iteration, so the first key is always the oldest-inserted one.
 *
 * Use for caches where losing a random entry is at worst a re-fetch: redis
 * fallbacks, CSRF token memory fallback, CORS domain checks, etc. Do not
 * use for anything that requires durability.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number) {
    super();
    if (maxEntries <= 0) {
      throw new Error(`BoundedMap maxEntries must be > 0 (got ${maxEntries})`);
    }
  }

  set(key: K, value: V): this {
    // If we already have this key, a plain set() just updates the value
    // in place without growing the map — no eviction needed.
    if (!this.has(key) && this.size >= this.maxEntries) {
      // Evict the oldest entry. Map preserves insertion order, so
      // keys().next() is always the first-inserted key.
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}
