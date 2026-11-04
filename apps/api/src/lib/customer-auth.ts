/**
 * Storefront CUSTOMER auth on the StoreDO (NEON-ZERO-1 N-9, Ruling NZ-A3): routing, markers, the DO client and the scoped
 * one-time tokens. Merchant / staff / admin auth is identity-service based and never comes through here.
 *
 * A DO store's customers are served by its StoreDO exactly when D1 `system_settings` holds `customer_auth_cutover.<storeId>`
 * (per store) or `customer_auth_cutover.__all` (global). Only `scripts/cf/cutover-customer-auth.mjs --commit` (the CONTROLLER)
 * writes them, after copying and verifying the store's rows. Before the marker every call is served by Postgres exactly as
 * before (Ruling NEON-ZERO-2: one marker, one source of truth, no dual read).
 *
 * Marker staleness class: BOUNDED, one-way. "On" is cached for the life of the isolate (never removed; a rollback is a new
 * deploy). "Off" is re-read at most every OFF_TTL_MS per isolate and store. The marker unreadable -> 503 (fail closed).
 * Freeze: while `customer_auth_freeze.<storeId>` exists, a Postgres WRITE of that store's customer-auth rows is a retryable 503,
 * so none can land between the copy and the flip (cached FREEZE_TTL_MS per isolate; the script waits longer before copying).
 */
import crypto from 'crypto';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { backendFor, storeDo } from './store-backend';

export const OFF_TTL_MS = 10_000;
export const FREEZE_TTL_MS = 5_000;
export const markerKey = (storeId: string) => `customer_auth_cutover.${storeId}`;
export const GLOBAL_MARKER_KEY = 'customer_auth_cutover.__all';
export const freezeKey = (storeId: string) => `customer_auth_freeze.${storeId}`;
/** Written by the script while ANY store is frozen: unscoped Postgres-era tokens (reset links) cannot name their store. */
export const ANY_FREEZE_KEY = 'customer_auth_freeze.__any';

interface MarkerD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
  };
}
const d1 = () => (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;

const on = new Set<string>();
const offUntil = new Map<string, number>();
const freezeCache = new Map<string, { frozen: boolean; until: number }>();
/** Test seam. */
export function resetCustomerAuthCaches(): void {
  on.clear();
  offUntil.clear();
  freezeCache.clear();
}

const unreadable = () =>
  new AppError(503, 'CUSTOMER_AUTH_CUTOVER_UNREADABLE', 'Platform database is unavailable');

/** True when this store's customers are served by its StoreDO. Binding absent (Node, unit tests) -> false. */
export async function customerAuthOnDo(storeId: string): Promise<boolean> {
  if (on.has(storeId)) return true;
  const db = d1();
  if (!db) return false;
  if ((offUntil.get(storeId) ?? 0) > Date.now()) return false;
  try {
    // ONE read for both markers; "on" is cached, so a hot store reads D1 once per isolate.
    const row = await db
      .prepare('SELECT 1 AS ok FROM system_settings WHERE key IN (?1, ?2) LIMIT 1')
      .bind(markerKey(storeId), GLOBAL_MARKER_KEY)
      .first<{ ok: number }>();
    if (row) {
      on.add(storeId);
      return true;
    }
    offUntil.set(storeId, Date.now() + OFF_TTL_MS);
    return false;
  } catch {
    throw unreadable();
  }
}

/** Throws a retryable 503 when the store's customer-auth rows are frozen for a copy. Call only for writes that go to Postgres. */
export async function assertCustomerAuthNotFrozen(storeId: string): Promise<void> {
  return assertFrozenKey(storeId, freezeKey(storeId));
}

/** For a Postgres-era token that names no store (reset link): refused while ANY store is being copied. */
export async function assertNoCustomerAuthFreeze(): Promise<void> {
  return assertFrozenKey('__any', ANY_FREEZE_KEY);
}

async function assertFrozenKey(cacheKey: string, key: string): Promise<void> {
  const db = d1();
  if (!db) return;
  let c = freezeCache.get(cacheKey);
  if (!c || c.until <= Date.now()) {
    try {
      const row = await db
        .prepare('SELECT 1 AS ok FROM system_settings WHERE key = ?1')
        .bind(key)
        .first<{ ok: number }>();
      c = { frozen: !!row, until: Date.now() + FREEZE_TTL_MS };
      freezeCache.set(cacheKey, c);
    } catch {
      throw unreadable();
    }
  }
  if (c.frozen)
    throw new AppError(503, 'CUSTOMER_AUTH_FROZEN', 'This data is being moved; retry in a minute', {
      retryAfterSeconds: 30,
    });
}

export type CustomerAuthRoute = { kind: 'do'; client: CustomerAuthClient } | { kind: 'pg' };

/**
 * Where a storefront customer's auth lives. `storeId` null/undefined = the admin namespace -> pg (never the DO).
 * `write`: a Postgres-bound WRITE for a DO store is refused (503) while its rows are frozen for the copy.
 */
export async function customerAuthRoute(
  storeId: string | null | undefined,
  opts: { write: boolean }
): Promise<CustomerAuthRoute> {
  if (!storeId || typeof storeId !== 'string') return { kind: 'pg' };
  if ((await backendFor(storeId)) !== 'do') return { kind: 'pg' };
  if (await customerAuthOnDo(storeId))
    return { kind: 'do', client: new CustomerAuthClient(storeId) };
  if (opts.write) await assertCustomerAuthNotFrozen(storeId);
  return { kind: 'pg' };
}

interface AuthStub {
  authOp(
    storeId: string,
    op: string,
    argsJson: string
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; status: number; message: string }
  >;
}

/** The DO's customer-auth operations (packages/repo/src/do/customer-auth.ts). A refusal is an AppError with the DO's status. */
export class CustomerAuthClient {
  constructor(readonly storeId: string) {}

  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const { encodeRpc, decodeRpc } = await import('@ebda-src/repo');
    const stub = storeDo(this.storeId) as unknown as AuthStub;
    const r = await stub.authOp(this.storeId, op, encodeRpc(args));
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc<T>(r.json);
  }
}

// ---- one-time tokens (email verification, password reset) -------------------------------------------------------------------
// A token for a DO store carries its store id, so redeeming it addresses the right DO without a directory read:
// `<storeId>~<64 hex>`. Only the sha256 of the whole string is stored. The store id is not a secret; a token still needs its
// 256 random bits to match a row in THAT store's DO, so naming another store's id only reaches a DO that does not hold it.
const SCOPED = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})~([a-f0-9]{64})$/;

export function mintScopedToken(storeId: string): { token: string; hash: string } {
  const token = `${storeId}~${crypto.randomBytes(32).toString('hex')}`;
  return { token, hash: sha256(token) };
}
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function scopedTokenStore(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 256) return null;
  const m = SCOPED.exec(token);
  return m ? m[1] : null;
}

/** The DO client for a presented scoped token, or null when the token is not scoped / the store is not on its DO. */
export async function clientForScopedToken(token: unknown): Promise<CustomerAuthClient | null> {
  const storeId = scopedTokenStore(token);
  if (!storeId) return null;
  const r = await customerAuthRoute(storeId, { write: false });
  return r.kind === 'do' ? r.client : null;
}
