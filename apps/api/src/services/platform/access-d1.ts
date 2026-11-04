/**
 * NEON-ZERO-1 (N-6 / N-7): store access and membership on D1, behind the `access` cutover marker
 * (services/platform/cutover.ts; family models `storeStaff`, `staffInvite`).
 *
 * ONE source per fact once the marker exists (Ruling NEON-ZERO-2, no dual-read):
 *   - membership (`store_staff`) and invitations (`staff_invites`): D1. Reads AND writes, through the routed `prisma` proxy
 *     (router.ts) or the statements below.
 *   - the facts the gate decides on (owner, status, billing suspension, name, deleted): D1 `stores`, the directory row that
 *     store-directory-sync.ts mirrors from every Store write in the same handler (Postgres stays authoritative for the Store
 *     row until N-18; the hourly reconcile repairs drift). Owner transfer / suspension / delete reach D1 in the request that
 *     made them, before the response.
 *
 * Staleness class of the gate: NEVER-stale. There is no cache of membership or owner anywhere: every admin request reads D1
 * (one statement, `gateRead`), so removing a staff member or transferring ownership takes effect on the very next request,
 * independent of the (<= 5 min) token claims. The only memo is per request (store-access.ts). `invalidate*`: none needed.
 *
 * D1 has no `SELECT ... FOR UPDATE`. What replaces the Postgres seat lock (`assertWithinLimit` under a store row lock):
 * one `INSERT ... SELECT ... WHERE (SELECT count(*)) < cap` statement per membership, and for an invitation accept one
 * `batch` (atomic) of that insert plus the invite consume, so two simultaneous accepts cannot both take the last seat and a
 * failed seat check never burns the invitation.
 */
import { prisma, withStore, type StoreStatus } from '@ebda/database';
import { cfBindings } from '../../cf/bindings';
import { AppError } from '../../middleware/error-handler';
import { platformFamilyOnD1 } from './cutover';

interface Stmt {
  bind(...v: unknown[]): Stmt & {
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run(): Promise<{ meta?: { changes?: number } }>;
  };
}
interface RawD1 {
  prepare(sql: string): Stmt;
  batch(stmts: unknown[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

function raw(): RawD1 {
  const d1 = (cfBindings() as { PLATFORM_DB?: RawD1 } | undefined)?.PLATFORM_DB;
  if (!d1) throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
  return d1;
}

type TenantTx = Parameters<Parameters<typeof withStore>[1]>[0];

/** Is store membership served by D1 now? Binding absent (Node, unit tests, local dev) -> false. */
export const onAccessD1 = (): Promise<boolean> => platformFamilyOnD1('access');

/**
 * `withStore` for a callback that touches only access-family models. After the cutover it runs the callback on the routed
 * `prisma` proxy WITHOUT opening a Postgres tenant transaction (so it works with Postgres down); before it, exactly
 * `withStore`. Never put a non-family model call inside `fn`: after the cutover it would run outside any tenant scope.
 */
export async function inAccessScope<T>(
  storeId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  if (await onAccessD1()) return fn(prisma as unknown as TenantTx);
  return withStore(storeId, fn);
}

export interface GateStore {
  id: string;
  ownerId: string;
  name: string;
  status: StoreStatus;
  billingSuspendedReason: string | null;
  createdAt: Date | null;
}

/**
 * The whole access decision input in ONE D1 statement: the store row and, when `userId` is given, whether that user holds a
 * `store_staff` row for it. `null` = no such store (404). A soft-deleted store is NOT hidden here, exactly like the Postgres
 * gate (it filters on id only); `retireStoreDirectoryRow` marks deleted stores inactive.
 */
export async function gateRead(
  storeId: string,
  userId: string | null
): Promise<{ store: GateStore; isStaff: boolean } | null> {
  let row: {
    id: string;
    owner_id: string;
    name: string;
    status: string;
    billing_suspended_reason: string | null;
    created_at: number | null;
    staff_id: string | null;
  } | null;
  try {
    row = await raw()
      .prepare(
        `SELECT s.id, s.owner_id, s.name, s.status, s.billing_suspended_reason, s.created_at, m.id AS staff_id
           FROM stores s
           LEFT JOIN store_staff m ON m.store_id = s.id AND m.user_id = ?2
          WHERE s.id = ?1`
      )
      .bind(storeId, userId ?? '')
      .first();
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Fail closed: an unreadable membership store is an outage, never "allowed" and never a 404.
    throw new AppError(503, 'ACCESS_UNAVAILABLE', 'Access check is unavailable, try again');
  }
  if (!row) return null;
  return {
    store: {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      status: row.status as StoreStatus,
      billingSuspendedReason: row.billing_suspended_reason,
      createdAt: row.created_at === null ? null : new Date(Number(row.created_at)),
    },
    isStaff: row.staff_id !== null,
  };
}

/** Ids (of `ids`) of stores that exist in the directory and are not soft-deleted. */
export async function liveStoreIdsD1(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const r = await raw()
      .prepare(`SELECT id FROM stores WHERE deleted_at IS NULL AND id IN (${marks})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const x of r.results ?? []) out.add(x.id);
  }
  return out;
}

/** The live (not soft-deleted) stores `ownerId` owns, id order. D1 twin of `ebda_owned_store_ids`. */
export async function ownedStoreIdsD1(ownerId: string): Promise<string[]> {
  const r = await raw()
    .prepare('SELECT id FROM stores WHERE owner_id = ?1 AND deleted_at IS NULL ORDER BY id')
    .bind(ownerId)
    .all<{ id: string }>();
  return (r.results ?? []).map(x => x.id);
}

/** Is `userId` the owner of a live store `storeId`? (merchant MCP key check). */
export async function isOwnerD1(storeId: string, userId: string): Promise<boolean> {
  const r = await gateRead(storeId, null);
  return r?.store.ownerId === userId;
}

const SEAT_INSERT = `INSERT INTO store_staff (id, store_id, user_id, created_at)
  SELECT ?1, ?2, ?3, ?4
   WHERE EXISTS (SELECT 1 FROM stores WHERE id = ?2)
     AND NOT EXISTS (SELECT 1 FROM store_staff WHERE store_id = ?2 AND user_id = ?3)
     AND (?5 IS NULL OR (SELECT count(*) FROM store_staff WHERE store_id = ?2) < ?5)`;

/**
 * Add a staff member under the seat cap (`cap` null = unlimited) in ONE statement. Returns the new membership id, or `null`
 * when nothing was inserted (already a member, no such store, or the cap is full: the caller tells them apart).
 */
export async function addStaffWithinCap(
  storeId: string,
  userId: string,
  cap: number | null
): Promise<string | null> {
  const id = crypto.randomUUID();
  const r = await raw().prepare(SEAT_INSERT).bind(id, storeId, userId, Date.now(), cap).run();
  return Number(r.meta?.changes ?? 0) === 1 ? id : null;
}

/**
 * Accept an invitation atomically (one D1 `batch`): add the membership under the cap if the invite is pending and unexpired,
 * then consume the invite ONLY IF the user is a member afterwards. A full cap therefore leaves the invite pending (the
 * Postgres version rolled the consume back with the transaction). `added` = a membership row was created, `consumed` = the
 * invite moved to accepted by this call.
 */
export async function acceptInviteWithinCap(input: {
  inviteId: string;
  storeId: string;
  email: string;
  userId: string;
  cap: number | null;
}): Promise<{ added: boolean; consumed: boolean }> {
  const now = Date.now();
  const d1 = raw();
  const insert = d1
    .prepare(
      `INSERT INTO store_staff (id, store_id, user_id, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM staff_invites WHERE id = ?6 AND store_id = ?2 AND email = ?7 AND status = 'pending' AND expires_at > ?4)
        AND NOT EXISTS (SELECT 1 FROM store_staff WHERE store_id = ?2 AND user_id = ?3)
        AND (?5 IS NULL OR (SELECT count(*) FROM store_staff WHERE store_id = ?2) < ?5)`
    )
    .bind(
      crypto.randomUUID(),
      input.storeId,
      input.userId,
      now,
      input.cap,
      input.inviteId,
      input.email
    );
  const consume = d1
    .prepare(
      `UPDATE staff_invites SET status = 'accepted', accepted_by = ?1, decided_at = ?2
      WHERE id = ?3 AND store_id = ?4 AND email = ?5 AND status = 'pending' AND expires_at > ?2
        AND EXISTS (SELECT 1 FROM store_staff WHERE store_id = ?4 AND user_id = ?1)`
    )
    .bind(input.userId, now, input.inviteId, input.storeId, input.email);
  let res: Array<{ meta?: { changes?: number } }>;
  try {
    res = await d1.batch([insert, consume]);
  } catch {
    throw new AppError(503, 'ACCESS_UNAVAILABLE', 'Access change is unavailable, try again');
  }
  return {
    added: Number(res[0]?.meta?.changes ?? 0) === 1,
    consumed: Number(res[1]?.meta?.changes ?? 0) === 1,
  };
}
