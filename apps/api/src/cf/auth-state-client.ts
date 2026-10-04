// Client side of the AuthState Durable Object: shard routing + one-call `apply`.
import { cfBindings, type DurableObjectStubLike } from './bindings';
import type { Op } from './auth-state-core';

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
  return stub(shardOf(key)).apply(ops);
}

/** Run ops on EVERY shard (sweeps: prefix scans). */
export async function applyOnAll(ops: Op[]): Promise<unknown[][]> {
  return Promise.all(Array.from({ length: AUTH_STATE_SHARDS }, (_, i) => stub(i).apply(ops)));
}

export function authStateAvailable(): boolean {
  return cfBindings()?.AUTH_STATE !== undefined;
}
