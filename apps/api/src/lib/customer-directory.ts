/**
 * Customer directory reads for a store served by its StoreDO (NEON-ZERO-1 N-9, Ruling NZ-N9-6). After the customer-auth
 * cutover the Postgres `users` row of such a customer is a STALE copy: a reader that still asks Postgres can show a pre-flip
 * name, email a deleted/erased customer, or treat a suspended one as active. Every customer reader that feeds an
 * authorization decision, an email, a PII export/erasure or the merchant admin's customer/order display goes through here.
 *
 * `customerRows` returns `null` when the store is NOT DO-served: the caller then runs its unchanged Postgres query, so with
 * every marker off nothing changes. One DO call per request per ids batch (`profiles`, <= 500 ids).
 */
import { customerAuthRoute } from './customer-auth';

export interface CustomerRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  emailVerified: boolean;
  language: string;
  avatar: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
}

interface Wire {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  emailVerified: boolean;
  language: string;
  avatar: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  deletedAt: number | null;
}
const toRow = (w: Wire): CustomerRow => ({
  id: w.id,
  email: w.email,
  firstName: w.firstName,
  lastName: w.lastName,
  phone: w.phone,
  status: w.status,
  emailVerified: w.emailVerified,
  language: w.language,
  avatar: w.avatar,
  createdAt: new Date(w.createdAt),
  lastLoginAt: w.lastLoginAt === null ? null : new Date(w.lastLoginAt),
  deletedAt: w.deletedAt === null ? null : new Date(w.deletedAt),
});

/** An account that may act / be priced / be mailed: active and not soft-deleted. */
export const isLiveCustomer = (c: Pick<CustomerRow, 'status' | 'deletedAt'>): boolean =>
  c.status === 'active' && c.deletedAt === null;

export async function customerRows(
  storeId: string,
  ids: ReadonlyArray<string | null | undefined>
): Promise<CustomerRow[] | null> {
  const route = await customerAuthRoute(storeId, { write: false });
  if (route.kind !== 'do') return null;
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const out: CustomerRow[] = [];
  for (let i = 0; i < want.length; i += 500)
    out.push(
      ...(await route.client.call<Wire[]>('profiles', { ids: want.slice(i, i + 500) })).map(toRow)
    );
  return out;
}

/**
 * Super-admin search inside ONE store's customer directory (Ruling NZ-C-12): email / phone contains `q` (>= 3 chars), newest first.
 * `null` when the store is not DO-served (the Postgres path is the caller's).
 */
export async function searchCustomerRows(
  storeId: string,
  q: string,
  limit = 10
): Promise<CustomerRow[] | null> {
  const route = await customerAuthRoute(storeId, { write: false });
  if (route.kind !== 'do') return null;
  return (await route.client.call<Wire[]>('search', { q, limit })).map(toRow);
}

/** One customer, `undefined` when the store is not DO-served (run the Postgres query), `null` when the DO does not know it. */
export async function customerRow(
  storeId: string,
  id: string | null | undefined
): Promise<CustomerRow | null | undefined> {
  if (!id)
    return (await customerAuthRoute(storeId, { write: false })).kind === 'do' ? null : undefined;
  const rows = await customerRows(storeId, [id]);
  return rows === null ? undefined : (rows[0] ?? null);
}

/** The fields of `row` named by a Prisma-style `select` (plus `id`), for readers that return the select's shape. */
export function pickSelected(
  row: CustomerRow,
  select: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const k of Object.keys(select))
    if (select[k]) out[k] = (row as unknown as Record<string, unknown>)[k];
  return out;
}
