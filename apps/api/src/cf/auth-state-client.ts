// Client side of the AuthState Durable Object: shard routing + one-call `apply`.
import { cfBindings, type DurableObjectStubLike } from './bindings';
import type { Op } from './auth-state-core';
import { hop } from '../lib/hop-timing';

export const CACHEGEN_PREFIX = 'cachegen:';
const CACHEGEN_SHARD_KEY = 'cachegen';

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
  // Cache-generation counters (`cachegen:<name>`) are read as a group of ~5 names on every public
  // cache fill, twice. Spread over 5 shards that was 5 parallel Durable Object round trips whose
  // slowest (a cold shard: 0.8-1.3 s measured) set the latency; on ONE shard it is one call. The
  // counters are only a fill-race guard (a lost counter can only make a fill skip caching once),
  // never an authorisation decision, so concentrating them is safe.
  if (key.startsWith(CACHEGEN_PREFIX)) return CACHEGEN_SHARD_KEY;
  return key.replace(/:(attempts|locked|row)$/, '');
}

export function shardOf(key: string): number {
  return fnv1a(shardKey(key)) % AUTH_STATE_SHARDS;
}

interface AuthStateStub extends DurableObjectStubLike {
  apply(ops: Op[]): Promise<unknown[]>;
}

function stub(shard: number): AuthStateStub {
  const ns = cfBindings()?.AUTH_STATE;
  if (!ns) throw new Error('AUTH_STATE Durable Object binding is not configured');
  return ns.get(ns.idFromName(`shard-${shard}`)) as unknown as AuthStateStub;
}

/** Run ops on the shard owning `key` (atomically, in order). */
export function applyOn(key: string, ops: Op[]): Promise<unknown[]> {
  return hop(
    `do-${key.split(':')[0]}-${String(ops[0]?.[0] ?? 'op')}${ops.length > 1 ? `x${ops.length}` : ''}`,
    () => stub(shardOf(key)).apply(ops)
  );
}

/** Run ops on EVERY shard (sweeps: prefix scans). */
export async function applyOnAll(ops: Op[]): Promise<unknown[][]> {
  return Promise.all(Array.from({ length: AUTH_STATE_SHARDS }, (_, i) => stub(i).apply(ops)));
}

export function authStateAvailable(): boolean {
  return cfBindings()?.AUTH_STATE !== undefined;
}
