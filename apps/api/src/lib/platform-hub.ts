/**
 * NEON-ZERO (Ruling NZ-C-4): the super-admin hub's cross-store reads with NO Postgres.
 *
 * Once the `billing`, `access` and `platform` families are on D1 (`hubOnD1`), the platform directory is D1 `stores`, the
 * accounts are the identity service's, and a store's own rows are its StoreDO. Every list here is BOUNDED: a page is a
 * D1 `LIMIT/OFFSET`, a cross-store fan-out is capped at `SUPER_ADMIN_FANOUT_CAP` stores and runs with a bounded pool
 * (`HUB_FANOUT_CONCURRENCY`), never one task per store at once. A fan-out that is cut says so (`truncated`), so a total is
 * never silently partial. Unreadable D1 / identity = 503 (the helpers below throw), never a Postgres fallback.
 *
 * Staleness class: NEVER-stale, no cache here (every call is a fresh D1 / DO / identity read).
 */
import { d1All } from '../services/platform/billing-d1';
import { platformFamilyOnD1 } from '../services/platform/cutover';
import { getAccountsBrief } from './identity-client';
import type { AccountBrief } from '../cf/bindings';
import { searchCustomerRows } from './customer-directory';

export const HUB_FANOUT_CAP = 500;
export const HUB_FANOUT_CONCURRENCY = 8;

/** True when the hub must read D1 / DOs / identity (all three platform families moved). */
export async function hubOnD1(): Promise<boolean> {
  const [b, a, p] = await Promise.all([
    platformFamilyOnD1('billing'),
    platformFamilyOnD1('access'),
    platformFamilyOnD1('platform'),
  ]);
  return b && a && p;
}

export interface HubStore {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  domain: string | null;
  status: string;
  plan: string;
  ownerId: string;
  createdAt: Date;
  storageBackend: 'pg' | 'do';
}

interface StoreRow {
  id: string;
  name: string;
  name_ar: string | null;
  slug: string;
  domain: string | null;
  status: string;
  plan: string;
  owner_id: string;
  created_at: number;
  storage_backend: 'pg' | 'do';
}
const COLS = 'id, name, name_ar, slug, domain, status, plan, owner_id, created_at, storage_backend';
const toStore = (r: StoreRow): HubStore => ({
  id: r.id,
  name: r.name,
  nameAr: r.name_ar,
  slug: r.slug,
  domain: r.domain,
  status: r.status,
  plan: r.plan,
  ownerId: r.owner_id,
  createdAt: new Date(Number(r.created_at)),
  storageBackend: r.storage_backend,
});

const like = (s: string) => `%${s.replace(/[\\%_]/g, m => `\\${m}`).toLowerCase()}%`;

/** One page of live stores, newest first (D1 LIMIT/OFFSET, plus the filtered total). */
export async function hubStorePage(f: {
  search?: string;
  status?: string;
  ownerId?: string;
  ids?: string[];
  skip: number;
  take: number;
}): Promise<{ rows: HubStore[]; total: number }> {
  const where: string[] = ['deleted_at IS NULL'];
  const p: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => {
    where.push(sql.replace(/\?/g, () => `?${p.push(v.shift())}`));
  };
  if (f.ownerId) add('owner_id = ?', f.ownerId);
  if (f.status) add('status = ?', f.status);
  if (f.ids) {
    if (f.ids.length === 0) return { rows: [], total: 0 };
    where.push(`id IN (${f.ids.map(i => `?${p.push(i)}`).join(', ')})`);
  }
  if (f.search) {
    const s = like(f.search);
    where.push(
      `(lower(name) LIKE ?${p.push(s)} ESCAPE '\\' OR lower(slug) LIKE ?${p.push(s)} ESCAPE '\\' OR lower(coalesce(domain, '')) LIKE ?${p.push(s)} ESCAPE '\\')`
    );
  }
  const w = where.join(' AND ');
  const [rows, count] = await Promise.all([
    d1All<StoreRow>(
      `SELECT ${COLS} FROM stores WHERE ${w} ORDER BY created_at DESC, id LIMIT ?${p.length + 1} OFFSET ?${p.length + 2}`,
      ...p,
      Math.min(Math.max(f.take, 1), 100),
      Math.max(f.skip, 0)
    ),
    d1All<{ n: number }>(`SELECT COUNT(*) AS n FROM stores WHERE ${w}`, ...p),
  ]);
  return { rows: rows.map(toStore), total: Number(count[0]?.n ?? 0) };
}

/** Live stores by id (any order), chunked for D1's parameter limit. */
export async function hubStoresById(ids: string[]): Promise<HubStore[]> {
  const out: HubStore[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const rows = await d1All<StoreRow>(
      `SELECT ${COLS} FROM stores WHERE deleted_at IS NULL AND id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`,
      ...chunk
    );
    out.push(...rows.map(toStore));
  }
  return out;
}

/**
 * Ids of the live stores a cross-store view covers, newest first, capped. `owner` limits to a store admin's own stores.
 * `truncated` is true when more stores exist than the cap (the caller must say the view is partial).
 */
export async function hubFanoutStoreIds(
  owner?: string,
  only?: string[]
): Promise<{ ids: string[]; truncated: boolean }> {
  if (only) return { ids: only.slice(0, HUB_FANOUT_CAP), truncated: only.length > HUB_FANOUT_CAP };
  const rows = await d1All<{ id: string }>(
    `SELECT id FROM stores WHERE deleted_at IS NULL ${owner ? 'AND owner_id = ?1' : ''} ORDER BY created_at DESC, id LIMIT ${HUB_FANOUT_CAP + 1}`,
    ...(owner ? [owner] : [])
  );
  return {
    ids: rows.slice(0, HUB_FANOUT_CAP).map(r => r.id),
    truncated: rows.length > HUB_FANOUT_CAP,
  };
}

/** `fn` for each id with at most `HUB_FANOUT_CONCURRENCY` in flight; a failing store is skipped and reported, never fatal. */
export async function hubFanout<T>(
  ids: string[],
  fn: (storeId: string) => Promise<T>,
  onError?: (storeId: string, err: unknown) => void
): Promise<Array<{ storeId: string; value: T }>> {
  const out: Array<{ storeId: string; value: T } | undefined> = new Array(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(HUB_FANOUT_CONCURRENCY, ids.length || 1) }, async () => {
      while (next < ids.length) {
        const i = next++;
        try {
          out[i] = { storeId: ids[i], value: await fn(ids[i]) };
        } catch (err) {
          if (!onError) throw err;
          onError(ids[i], err);
        }
      }
    })
  );
  return out.filter((r): r is { storeId: string; value: T } => r !== undefined);
}

export type HubOwner = { id: string; email: string; firstName: string; lastName: string };

/** Owners of stores as the identity service knows them. An unknown / erased owner is simply absent. */
export async function hubOwners(ownerIds: string[]): Promise<Map<string, HubOwner>> {
  const briefs = await getAccountsBrief(ownerIds);
  return new Map(
    briefs.map(b => [
      b.id,
      { id: b.id, email: b.email, firstName: b.firstName, lastName: b.lastName },
    ])
  );
}

/**
 * The accounts the platform user directory can enumerate without a users table: every store owner and every staff member, plus
 * `extra` (the caller). Newest stores first, capped. Customers of a store are NOT here: they live in that store's DO.
 */
export async function hubAccountIds(
  extra: string[]
): Promise<{ ids: string[]; truncated: boolean }> {
  const rows = await d1All<{ uid: string }>(
    `SELECT uid FROM (
       SELECT owner_id AS uid, created_at AS at FROM stores WHERE deleted_at IS NULL
       UNION ALL
       SELECT s.user_id AS uid, s.created_at AS at FROM store_staff s JOIN stores st ON st.id = s.store_id AND st.deleted_at IS NULL
     ) GROUP BY uid ORDER BY max(at) DESC LIMIT ${HUB_FANOUT_CAP + 1}`
  );
  const ids = [...new Set([...extra, ...rows.map(r => r.uid)])];
  return { ids: ids.slice(0, HUB_FANOUT_CAP), truncated: rows.length > HUB_FANOUT_CAP };
}

/** The (id, name, slug) of the live stores `userId` owns, newest first. */
export async function hubOwnedStores(
  ownerIds: string[]
): Promise<Map<string, Array<{ id: string; name: string; slug: string }>>> {
  const out = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  for (let i = 0; i < ownerIds.length; i += 50) {
    const chunk = ownerIds.slice(i, i + 50);
    const rows = await d1All<{ id: string; name: string; slug: string; owner_id: string }>(
      `SELECT id, name, slug, owner_id FROM stores WHERE deleted_at IS NULL AND owner_id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')}) ORDER BY created_at DESC`,
      ...chunk
    );
    for (const r of rows) {
      const l = out.get(r.owner_id) ?? [];
      l.push({ id: r.id, name: r.name, slug: r.slug });
      out.set(r.owner_id, l);
    }
  }
  return out;
}

export type HubUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: AccountBrief['role'];
  status: AccountBrief['status'];
  createdAt: Date;
  lastLoginAt: Date | null;
  stores: Array<{ id: string; name: string; slug: string }>;
};

export async function hubUsers(briefs: AccountBrief[]): Promise<HubUser[]> {
  const owned = await hubOwnedStores(briefs.map(b => b.id));
  return briefs.map(b => ({
    id: b.id,
    email: b.email,
    firstName: b.firstName,
    lastName: b.lastName,
    role: b.role,
    status: b.status,
    createdAt: new Date(b.createdAt),
    lastLoginAt: b.lastLoginAt ? new Date(b.lastLoginAt) : null,
    stores: owned.get(b.id) ?? [],
  }));
}

export type HubCustomerHit = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  role: 'customer';
  storeId: string;
  storeName: string;
  createdAt: Date;
  lastLoginAt: Date | null;
};

/**
 * Ruling NZ-C-12 - customers live in their store's StoreDO, so a super-admin customer search is a CAPPED FAN-OUT, not an index:
 * the newest `HUB_FANOUT_CAP` stores from D1, `HUB_FANOUT_CONCURRENCY` at once, each answering `search` (email / phone contains
 * `q`, >= 3 chars, 10 hits) from its own DO; hits are merged newest first and cut to `limit`. `truncated` is true when the
 * store list was cut, so "not found" never reads as "does not exist". A store that fails is skipped. A Postgres-backed
 * store is not searched here (it has no D1 customer directory). Cost if wrong: a customer of a store outside the newest 500 is
 * not found by search - widen with a D1 email-hash index (`customer_index`) if that is hit.
 */
export async function hubSearchCustomers(
  q: string,
  limit = 25
): Promise<{ hits: HubCustomerHit[]; truncated: boolean }> {
  const needle = q.trim();
  if (needle.length < 3) return { hits: [], truncated: false };
  const { ids, truncated } = await hubFanoutStoreIds();
  const names = new Map((await hubStoresById(ids)).map(s => [s.id, s.name]));
  const parts = await hubFanout(
    ids,
    async storeId => (await searchCustomerRows(storeId, needle, 10)) ?? [],
    () => undefined
  );
  const hits = parts
    .flatMap(p =>
      p.value.map(c => ({
        id: c.id,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        phone: c.phone,
        status: c.status,
        role: 'customer' as const,
        storeId: p.storeId,
        storeName: names.get(p.storeId) ?? '',
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
      }))
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
  return { hits, truncated };
}
