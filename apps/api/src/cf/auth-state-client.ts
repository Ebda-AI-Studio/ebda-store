// Client side of the AuthState Durable Object: shard routing + one-call `apply`.
import { cfBindings, type DurableObjectStubLike } from './bindings';
import type { Op } from './auth-state-core';
import { hop } from '../lib/hop-timing';

export const CACHEGEN_PREFIX = 'cachegen:';

/** Shards the key space is spread over. A key always maps to the same shard. */
export const AUTH_STATE_SHARDS = 32;

/** FNV-1a, 32 bit: stable across isolates and releases (a shard assignment must never move). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The shard identity of a key. The lockout counters for one account live under
 * `lockout:<email>:attempts` / `:locked`, a coalesced MCP denial under `<key>:row`:
 * stripping that suffix keeps every key of one logical subject on one shard, so a
 * pipeline over them stays atomic.
 */
export function shardKey(key: string): string {
  // PERF-RL-DO: the public request limiters of ONE client (per-IP, tenant-or-IP fallback, store-miss, search) share the
  // client's shard, so the counters one public request touches are one batched apply, not three serial round trips to three
  // instances (lib public-limit-prefetch). A tenant key (`t:<storeId>`) is its own subject, on its own shard.
  const rl = PUBLIC_RL_KEY.exec(key);
  if (rl) return `rl-client:${rl[1]}`;
  return key.replace(/:(attempts|locked|row)$/, '');
}
const PUBLIC_RL_KEY = /^rl:(?:public|public-tenant|store-miss|public-search):(.+)$/;

/**
 * Sentinel "shard" of the cache-generation counters: their OWN Durable Object instance
 * (`idFromName('cachegen')`), never one of the 32 auth shards. They are read as a group of ~5
 * names on every public cache fill (twice), so they are one call on one instance; and because
 * anyone can trigger cache misses on public pages, that traffic must never queue in front of the
 * shard holding jti / token-version / lockout / CSRF / MFA / rate-limit keys. The counters are
 * only a fill-race guard (a lost counter makes one fill skip caching), never an authorisation
 * decision.
 * PERF-RL-DO (Ruling PERF-RL-DO-1): the base instance no longer serves reads or bumps. The generic prefix names it held are
 * replicated on the store shards ({@link cachegenHome}); it stays only as the id of the generic per-key route and the sweeps.
 */
export const CACHEGEN_SHARD = -1;

/**
 * Store-scoped generations are spread over this many instances (Ruling NZ-D3): a name that carries a store id
 * (`public:products:<storeId>:...`) lives on `cachegen-s<n>`, n = fnv1a(storeId) mod 64, so one viral store's invalidations
 * and fills never queue behind another store's, and nothing funnels through a single object. Names with no store id (the
 * root, `public:`, `public:products:` prefix generations) stay on the base instance. Shard ids: -1 base, -2-n store shard n.
 */
export const CACHEGEN_STORE_SHARDS = 64;
const UUID_IN_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export function shardOf(key: string): number {
  if (key.startsWith(CACHEGEN_PREFIX)) {
    return cachegenHome(key.slice(CACHEGEN_PREFIX.length)) ?? CACHEGEN_SHARD;
  }
  return fnv1a(shardKey(key)) % AUTH_STATE_SHARDS;
}

const storeShard = (id: string): number => CACHEGEN_SHARD - 1 - (fnv1a(id) % CACHEGEN_STORE_SHARDS);

/**
 * The home instance of one cache-generation NAME (no `cachegen:` prefix), or `null` for a REPLICATED name (PERF-RL-DO).
 *
 *  - a name carrying a store id lives on that store's shard; the store STATUS generation (`public:store:resolve:<host>`) on its
 *    host's shard; any other leaf name (`dir:slug:<slug>`) on the shard of the name itself;
 *  - a generic PREFIX name with no id (`''`, `public:`, `public:products:`, `dir:slug:`, ...) is REPLICATED on every store
 *    shard: a read takes it from the shard the rest of its batch lives on ({@link cachegenAnchor}), a bump increments EVERY
 *    replica before it resolves. These names were the single global `cachegen` instance every cache fill and every edge-hit
 *    validation worldwide read (measured 2026-11-09: 6 serial calls to it on one cold store resolve). No write path bumps
 *    them today (every prefix bust carries a store id), so the fan-out costs nothing in practice and stays correct if one does.
 *
 * Correctness: a generation is only ever compared with a value read from the SAME instance (the anchor is a pure function of the
 * name list, and a fill / edge stamp re-reads the same list), and a bump of a replicated name lands on every replica before the
 * invalidation deletes, so a read that starts after the bump sees it on whichever replica it asks.
 */
export function cachegenHome(name: string): number | null {
  const id = name.match(UUID_IN_NAME)?.[0] ?? name.match(/^public:store:resolve:(.+)$/)?.[1];
  if (id) return storeShard(id);
  if (name === '' || name.endsWith(':')) return null;
  return storeShard(name);
}

/** The instance a batch of names reads its replicated names from: the store id's, else the status host's, else the first leaf's. */
export function cachegenAnchor(names: string[]): number {
  for (const n of names) {
    const id = n.match(UUID_IN_NAME)?.[0];
    if (id) return storeShard(id);
  }
  for (const n of names) {
    const host = n.match(/^public:store:resolve:(.+)$/)?.[1];
    if (host) return storeShard(host);
  }
  for (const n of names) {
    const home = cachegenHome(n);
    if (home !== null) return home;
  }
  return storeShard('');
}

/** Every store shard: where a replicated name's bump must land. */
export function cachegenStoreShards(): number[] {
  return Array.from({ length: CACHEGEN_STORE_SHARDS }, (_, i) => CACHEGEN_SHARD - 1 - i);
}

interface AuthStateStub extends DurableObjectStubLike {
  apply(ops: Op[]): Promise<unknown[]>;
}

/**
 * Where the cache-generation instance lives, overridable WITHOUT a code change so its first-wake
 * time can be measured per placement: `CACHEGEN_DO_NAME` (default `cachegen`; a new name is a new
 * instance, created at `CACHEGEN_LOCATION_HINT` if given) and the hint, one of Cloudflare's
 * region hints. Unset = today's behaviour exactly. The counters are only a cache fill-race guard
 * (never authorisation), so a fresh instance costs nothing; the auth shards are never affected.
 */
const LOCATION_HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
export function cachegenPlacement(env: Record<string, string | undefined> = process.env): {
  name: string;
  hint?: string;
} {
  const rawName = env.CACHEGEN_DO_NAME ?? '';
  const name = /^cachegen[a-z0-9-]{0,24}$/.test(rawName) ? rawName : 'cachegen';
  const rawHint = env.CACHEGEN_LOCATION_HINT ?? '';
  return { name, hint: LOCATION_HINTS.has(rawHint) ? rawHint : undefined };
}

function stub(shard: number): AuthStateStub {
  const ns = cfBindings()?.AUTH_STATE;
  if (!ns) throw new Error('AUTH_STATE Durable Object binding is not configured');
  if (shard <= CACHEGEN_SHARD) {
    const { name: base, hint } = cachegenPlacement();
    const name = shard === CACHEGEN_SHARD ? base : `${base}-s${CACHEGEN_SHARD - 1 - shard}`;
    return ns.get(
      ns.idFromName(name),
      hint ? { locationHint: hint } : undefined
    ) as unknown as AuthStateStub;
  }
  return ns.get(ns.idFromName(`shard-${shard}`)) as unknown as AuthStateStub;
}

/** Run ops on the shard owning `key` (atomically, in order). */
export function applyOn(key: string, ops: Op[]): Promise<unknown[]> {
  return hop(
    `do-${key.split(':')[0]}-${String(ops[0]?.[0] ?? 'op')}${ops.length > 1 ? `x${ops.length}` : ''}`,
    () => stub(shardOf(key)).apply(ops)
  );
}

/** Run ops on one explicit shard (cache generations route by name list, not by one key). */
export function applyOnShard(shard: number, ops: Op[]): Promise<unknown[]> {
  return hop(
    `do-cachegen-${String(ops[0]?.[0] ?? 'op')}${ops.length > 1 ? `x${ops.length}` : ''}`,
    () => stub(shard).apply(ops)
  );
}

/** Run ops on EVERY shard and the cache-generation instance (sweeps: prefix scans). */
export async function applyOnAll(ops: Op[]): Promise<unknown[][]> {
  return Promise.all([
    ...Array.from({ length: AUTH_STATE_SHARDS }, (_, i) => stub(i).apply(ops)),
    stub(CACHEGEN_SHARD).apply(ops),
  ]);
}

export function authStateAvailable(): boolean {
  return cfBindings()?.AUTH_STATE !== undefined;
}
