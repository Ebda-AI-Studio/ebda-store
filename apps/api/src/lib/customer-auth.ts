/**
 * Storefront CUSTOMER auth on the StoreDO (NEON-ZERO-1 N-9, Ruling NZ-A3): routing, markers, the DO client and the scoped
 * one-time tokens. Merchant / staff / admin auth is identity-service based and never comes through here.
 *
 * A DO store's customers are served by its StoreDO exactly when D1 `system_settings` holds `customer_auth_cutover.<storeId>`
 * (per store) or `customer_auth_cutover.__all` (global). Only `scripts/cf/cutover-customer-auth.mjs --commit` (the CONTROLLER)
 * writes them, after copying and verifying the store's rows. Before the marker every call is served by Postgres exactly as
 * before (Ruling NEON-ZERO-2: one marker, one source of truth, no dual read).
 *
 * ONE freeze mechanism: platform/cutover.ts `readCutoverKeys` (#407's), keyed per store here. The freeze row
 * carries an expiry, "off" is never cached while frozen, a write is refused while marker + freeze coexist, and the script
 * follows freeze -> drain -> snapshot -> copy -> verify -> flip -> settle -> drift check on a NEW connection -> lift.
 * Marker unreadable -> 503 (fail closed).
 */
import crypto from 'crypto';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { backendFor, storeDo } from './store-backend';
import { readCutoverKeys, resetCutoverCache, type MarkerD1 } from '../services/platform/cutover';

export const OFF_TTL_MS = 10_000;
export const markerKey = (storeId: string) => `customer_auth_cutover.${storeId}`;
export const GLOBAL_MARKER_KEY = 'customer_auth_cutover.__all';
export const freezeKey = (storeId: string) => `customer_auth_freeze.${storeId}`;
/** Written by the script while ANY store is frozen: unscoped Postgres-era tokens (reset links) cannot name their store. */
export const ANY_FREEZE_KEY = 'customer_auth_freeze.__any';

const d1 = () => (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;

// Freeze + marker semantics are platform/cutover.ts's `readCutoverKeys` (ONE mechanism, Ruling NZ-INTEG-1); only the keys
// are per store here. "off" is never cached while a freeze exists; a WRITE never trusts a cached "off" and is refused
// (retryable 503) while a freeze exists, marker or not.
const on = new Set<string>();
const offUntil = new Map<string, number>();
/** Test seam. */
export function resetCustomerAuthCaches(): void {
  on.clear();
  offUntil.clear();
  resetCutoverCache();
}

const unreadable = () =>
  new AppError(503, 'CUSTOMER_AUTH_CUTOVER_UNREADABLE', 'Platform database is unavailable');
const frozenError = () =>
  new AppError(503, 'CUSTOMER_AUTH_FROZEN', 'This data is being moved; retry in a minute', {
    retryable: true,
    retryAfterSeconds: 30,
  });

/** Marker (store or global) and freeze (store or any) in ONE read. */
const readKeys = (db: MarkerD1, storeId: string | null) =>
  readCutoverKeys(db, {
    markers: storeId ? [markerKey(storeId), GLOBAL_MARKER_KEY] : [],
    freezes: storeId ? [freezeKey(storeId), ANY_FREEZE_KEY] : [ANY_FREEZE_KEY],
    unreadable,
    unfreezeHint: () =>
      'node scripts/cf/cutover-customer-auth.mjs --unfreeze --store <id> (same --d1 flags)',
    alertTitle: 'Customer auth cutover: an expired freeze was left behind',
  });

/** READ path: true when this store's customers are served by its StoreDO. "On" is cached for good; "off" for OFF_TTL_MS, never while frozen. */
export async function customerAuthOnDo(storeId: string): Promise<boolean> {
  if (on.has(storeId)) return true;
  const db = d1();
  if (!db) return false;
  if ((offUntil.get(storeId) ?? 0) > Date.now()) return false;
  const { moved, frozen } = await readKeys(db, storeId);
  if (moved) {
    on.add(storeId);
    return true;
  }
  if (!frozen) offUntil.set(storeId, Date.now() + OFF_TTL_MS);
  return false;
}

/** WRITE path: never from a stale "off"; refused (503) while a freeze exists, marker or not (no mixed backends). */
async function customerAuthOnDoForWrite(storeId: string): Promise<boolean> {
  if (on.has(storeId)) return true;
  const db = d1();
  if (!db) return false;
  const { moved, frozen } = await readKeys(db, storeId);
  if (frozen) throw frozenError();
  if (moved) {
    on.add(storeId);
    return true;
  }
  return false;
}

/** For a Postgres-era token that names no store (reset link): refused while ANY store is being copied. */
export async function assertNoCustomerAuthFreeze(): Promise<void> {
  const db = d1();
  if (!db) return;
  if ((await readKeys(db, null)).frozen) throw frozenError();
}

/**
 * For store-create (#408): a store created ON a Durable Object has no Postgres customers to copy, so it starts with the marker
 * on. Call it in the SAME step that writes the D1 `stores` row with `storage_backend = 'do'`:
 *   `await markCustomerAuthOnDo(platformDb, store.id)`
 * Idempotent (`ON CONFLICT DO NOTHING`). Without it the new store's first customers register in Postgres.
 */
export async function markCustomerAuthOnDo(
  db: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  },
  storeId: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO system_settings (id, key, value, category, is_public) VALUES (?1, ?2, ?3, 'cutover', 0) ON CONFLICT (key) DO NOTHING"
    )
    .bind(crypto.randomUUID(), markerKey(storeId), JSON.stringify({ on: true, by: 'store-create' }))
    .run();
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
  const onDo = opts.write
    ? await customerAuthOnDoForWrite(storeId)
    : await customerAuthOnDo(storeId);
  return onDo ? { kind: 'do', client: new CustomerAuthClient(storeId) } : { kind: 'pg' };
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
