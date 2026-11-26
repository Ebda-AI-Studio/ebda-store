/**
 * Ported from the ownership-proof half of tests/integration/rls-wa-consent-erasure.test.ts (WA-CONSENT-1; Postgres, strict `ebda_app` RLS).
 * The real `phoneOnOwnOrder` runs on the StoreDO schema (node:sqlite through prisma-lite, the wiring of product-3d-models-do.test.ts), one
 * database PER STORE as in production. Proves: a DELIVERED order proves the number for ITS customer, a pending one proves nothing, another
 * customer's number proves nothing, number formats are matched in E.164, and the proof never crosses stores (store B's delivered order proves
 * nothing in store A, both as separate databases and as a leaked row inside A's own database: only the code's `storeId` filter stands there).
 * The RLS-specific intent (a proof read outside the tenant GUC returning zero rows under `ebda_app`) is Postgres-only: the DO has no GUC and a
 * store reads only its own database. The rest of the original lifecycle on a DO store is covered by tests/unit/consent-on-do.test.ts (the grant
 * is recorded, an unproven number is refused, no Postgres lock) and tests/unit/consent-residue-on-do.test.ts (account erasure revokes what it
 * owns BEFORE the order scrub, phone change revokes the old number, export lists the account rows).
 */
import { describe, it, expect, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dbs = { [A]: openSqlite(), [B]: openSqlite() } as Record<
  string,
  ReturnType<typeof openSqlite>
>;
const lites = Object.fromEntries(
  Object.entries(dbs).map(([k, d]) => [
    k,
    createPrismaLite(META, nodeSqlRunner(d), 'store-do', { unscoped: true }) as any,
  ])
) as Record<string, any>;

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async (id: string) => lites[id],
  storeWriter: async (id: string) => lites[id],
  storeRepo: async () => ({ backend: 'do' }),
}));

import { phoneOnOwnOrder } from '../../apps/api/src/lib/wa/consent';

const PHONE = '01001234567';
const OTHER_PHONE = '01112345678';
let n = 0;
function order(db: string, storeId: string, customerId: string, phone: string, status: string) {
  dbs[db]!.prepare(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, subtotal, total, shipping_address, billing_address)
     VALUES (?, ?, ?, ?, ?, 10, 10, ?, '{}')`
  ).run(`o-${++n}`, storeId, customerId, `wacon-${n}`, status, JSON.stringify({ phone }));
}

order(A, A, 'cust', PHONE, 'delivered'); // proves PHONE for the customer
order(A, A, 'other', OTHER_PHONE, 'pending'); // a pending order proves nothing
order(B, B, 'custb', OTHER_PHONE, 'delivered'); // store B's customer has a DELIVERED order with OTHER_PHONE

describe('WhatsApp consent ownership proof on the StoreDO schema (WA-CONSENT-1)', () => {
  it('a delivered order proves the number, a pending one does not', async () => {
    expect(await phoneOnOwnOrder(A, 'cust', PHONE)).toBe(true);
    expect(await phoneOnOwnOrder(A, 'other', OTHER_PHONE)).toBe(false);
  });

  it('the number is matched across formats, and only for the customer who placed the order', async () => {
    expect(await phoneOnOwnOrder(A, 'cust', '+201001234567')).toBe(true);
    expect(await phoneOnOwnOrder(A, 'cust', '+20 100 123 4567')).toBe(true);
    expect(await phoneOnOwnOrder(A, 'cust', OTHER_PHONE)).toBe(false); // not on any order of this customer
    expect(await phoneOnOwnOrder(A, 'someone-else', PHONE)).toBe(false); // another customer's delivered order
    expect(await phoneOnOwnOrder(A, 'cust', 'not-a-phone')).toBe(false);
  });

  it("the proof never crosses stores: another store's delivered order proves nothing in this store", async () => {
    expect(await phoneOnOwnOrder(B, 'custb', OTHER_PHONE)).toBe(true); // control: in ITS store the order proves the number
    expect(await phoneOnOwnOrder(A, 'custb', OTHER_PHONE)).toBe(false);
    // a row that leaked into A's own database naming store B: only the code's own storeId filter stands between the stores
    order(A, B, 'leaked', OTHER_PHONE, 'delivered');
    expect(await phoneOnOwnOrder(A, 'leaked', OTHER_PHONE)).toBe(false);
  });
});
