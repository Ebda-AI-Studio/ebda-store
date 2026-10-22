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
  return key.replace(/:(attempts|locked|row)$/, '');
}

/**
 * Sentinel "shard" of the cache-generation counters: their OWN Durable Object instance
 * (`idFromName('cachegen')`), never one of the 32 auth shards. They are read as a group of ~5
 * names on every public cache fill (twice), so they are one call on one instance; and because
 * anyone can trigger cache misses on public pages, that traffic must never queue in front of the
 * shard holding jti / token-version / lockout / CSRF / MFA / rate-limit keys. The counters are
 * only a fill-race guard (a lost counter makes one fill skip caching), never an authorisation
 * decision.
 */
export const CACHEGEN_SHARD = -1;

export function shardOf(key: string): number {
  if (key.startsWith(CACHEGEN_PREFIX)) return CACHEGEN_SHARD;
  return fnv1a(shardKey(key)) % AUTH_STATE_SHARDS;
}

interface AuthStateStub extends DurableObjectStubLike {
  apply(ops: Op[]): Promise<unknown[]>;
}

function stub(shard: number): AuthStateStub {
  const ns = cfBindings()?.AUTH_STATE;
  if (!ns) throw new Error('AUTH_STATE Durable Object binding is not configured');
  const name = shard === CACHEGEN_SHARD ? 'cachegen' : `shard-${shard}`;
  return ns.get(ns.idFromName(name)) as unknown as AuthStateStub;
}

/** Run ops on the shard owning `key` (atomically, in order). */
export function applyOn(key: string, ops: Op[]): Promise<unknown[]> {
  return hop(
    `do-${key.split(':')[0]}-${String(ops[0]?.[0] ?? 'op')}${ops.length > 1 ? `x${ops.length}` : ''}`,
    () => stub(shardOf(key)).apply(ops)
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
