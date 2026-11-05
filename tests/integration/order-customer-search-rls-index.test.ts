/**
 * Task 14, Rule C (defect class): the admin order search, the customer search and their trigram
 * indexes (orders.order_number, the guest shipping-contact JSON, users first/last/email/phone) must
 * be index-backed AS `ebda_app`, not only as the owner. Under RLS the policy is a security barrier
 * and `ILIKE` / `->>` are not LEAKPROOF, so an inline predicate can never be an index condition
 * (Ruling SEARCH-T14-1); the lookups therefore go through store-scoped SECURITY DEFINER id
 * functions. Evidence: each index's scan counter after running the production statements as
 * `ebda_app` under a store scope, plus the exact result set against an independent SQL oracle.
 * The earlier planner tests (order-search-guest-contact, order-search-indexes) ran as the owner.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma, Prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { createAppPlanner } from '../helpers/app-role-planner';

const { orderSearchWhere } = await import('../../apps/api/src/services/order.service');
const { searchOrderCustomers } =
  await import('../../apps/api/src/services/customer-search.service');

const planner = hasDb ? createAppPlanner() : null;
const ORDERS = 20_000;
const REGISTERED_ORDERS = 2_000; // orders 1..2000 belong to registered customers (10 %, like production)
const USERS = 1_000;
const tag = `oc${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
let storeId = '';
let ownerId = '';

/** The orders the admin list returns for `term`, through the production search arms, as ebda_app. */
const listIds = (term: string) =>
  planner!.inStore(storeId, async () => {
    const arms = await orderSearchWhere(storeId, term);
    const rows = await prisma.order.findMany({
      where: { storeId, deletedAt: null, OR: arms },
      select: { id: true },
    });
    return rows.map(r => r.id).sort();
  });

/** Independent oracle: plain SQL as the owner (no RLS), the same "contains, case-insensitive" meaning. */
async function oracle(term: string): Promise<string[]> {
  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT o.id FROM public.orders o LEFT JOIN public.users u ON u.id = o.customer_id
    WHERE o.store_id = ${storeId} AND o.deleted_at IS NULL AND (
      o.order_number ILIKE ${like}
      OR u.first_name ILIKE ${like} OR u.last_name ILIKE ${like}
      OR u.email ILIKE ${like} OR u.phone ILIKE ${like}
      OR (o.customer_id IS NULL AND (
            o.shipping_address ->> 'firstName' ILIKE ${like} OR o.shipping_address ->> 'lastName' ILIKE ${like}
         OR o.shipping_address ->> 'email' ILIKE ${like} OR o.shipping_address ->> 'phone' ILIKE ${like})))`);
  return rows.map(r => r.id).sort();
}

describe.skipIf(!hasDb)(
  'order + customer search use their trigram indexes under RLS (Task 14)',
  () => {
    beforeAll(async () => {
      ownerId = (
        await prisma.user.create({
          data: {
            email: `${tag}@x.test`,
            passwordHash: 'x',
            firstName: 'Oc',
            lastName: 'Owner',
            role: 'store_admin',
          },
        })
      ).id;
      storeId = (await prisma.store.create({ data: { name: tag, slug: tag, ownerId } })).id;
      await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at)
      SELECT ${tag} || '-u' || g, ${storeId}, 'ru' || md5(${tag} || 're' || g) || '@x.test', 'x',
             'uf' || md5(${tag} || 'uf' || g), 'ul' || md5(${tag} || 'ul' || g), '+2012' || lpad(g::text, 8, '0'),
             'customer', now()
      FROM generate_series(1, ${USERS}::int) g`;
      await prisma.$executeRaw`
      INSERT INTO public.orders
        (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at)
      -- billing_address carries ~1.2 KB, like a real order (address, phone, notes): a wide heap makes
      -- the store_id scan + filter clearly dearer than the trigram probes, so the plan does not flip.
      SELECT ${tag} || '-o' || g, ${storeId}, 'EB' || upper(md5(${tag} || 'o' || g)), 1000, 1000,
             CASE WHEN g <= ${REGISTERED_ORDERS}::int THEN '{}'::jsonb ELSE jsonb_build_object(
               'firstName', 'gf' || md5(${tag} || 'gf' || g), 'lastName', 'gl' || md5(${tag} || 'gl' || g),
               'email', 'ge' || md5(${tag} || 'ge' || g) || '@x.test', 'phone', '+2011' || lpad(g::text, 8, '0')) END,
             jsonb_build_object('note', repeat('x', 1200)),
             CASE WHEN g <= ${REGISTERED_ORDERS}::int THEN ${tag} || '-u' || ((g % ${USERS}::int) + 1) END,
             now()
      FROM generate_series(1, ${ORDERS}::int) g`;
      await prisma.$executeRaw`VACUUM (ANALYZE) public.orders`;
      await prisma.$executeRaw`VACUUM (ANALYZE) public.users`;
    }, 180_000);

    afterAll(async () => {
      if (storeId) {
        await prisma.$executeRaw`DELETE FROM public.orders WHERE store_id = ${storeId}`;
        await prisma.$executeRaw`DELETE FROM public.users WHERE store_id = ${storeId}`;
        await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
      }
      if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
      await planner?.close();
    }, 180_000);

    // [label, term, index that must be scanned or null]. Every term is a unique 10-hex-digit slice,
    // so the result is exactly one order. The orders-side searches must scan their trigram index.
    // The customer lookup (users) may legitimately probe the store's customers by key instead of
    // scanning a users GIN (the planner weighs both; a store's customers are bounded by the store),
    // so for those the evidence is the exact result and the time, not a counter. What it must NOT
    // do is run under the users RLS policy (a per-row subquery policy): inline it took ~0.5 s.
    // Search P2: the guest name and phone arms of the order list now go through the NORMALISED
    // expression indexes of 20261027000100 (the per-key indexes still serve `ebda_order_search_ids`).
    const g = 5000; // a guest order (orders 1..2000 are registered)
    const r = 77; // a registered customer's index (it has orders r and r+1000)
    // Each name / email term is the fixture's letter prefix + 8 hex chars, so it can never come out all digits: a digit-only
    // term is a phone / order-number search and never matches a name or an email (customer-patterns.ts), and a random
    // all-digit hex slice failed this probe on both attempts (PR 396 CI, customer email term 0676037783).
    const cases: Array<[string, string, string | null]> = [
      ['order number', md5(tag + 'o' + g).slice(2, 12), 'orders_order_number_trgm_idx'],
      [
        'guest first name',
        'gf' + md5(tag + 'gf' + g).slice(0, 8),
        'orders_guest_name_norm_trgm_idx',
      ],
      [
        'guest last name',
        'gl' + md5(tag + 'gl' + g).slice(0, 8),
        'orders_guest_name_norm_trgm_idx',
      ],
      ['guest email', 'ge' + md5(tag + 'ge' + g).slice(0, 8), 'orders_guest_email_trgm_idx'],
      ['guest phone', String(g).padStart(8, '0') + '', 'orders_guest_phone_digits_trgm_idx'],
      ['customer first name', 'uf' + md5(tag + 'uf' + r).slice(0, 8), null],
      ['customer last name', 'ul' + md5(tag + 'ul' + r).slice(0, 8), null],
      ['customer email', 'ru' + md5(tag + 're' + r).slice(0, 8), null],
      ['customer phone', String(r).padStart(8, '0'), null],
    ];

    for (const [label, term, index] of cases) {
      it(`order list: ${label} search is index-backed and fast as ebda_app (${index ?? 'key probe'})`, async () => {
        const want = await oracle(term);
        expect(want.length).toBeGreaterThan(0);
        const before = index ? await planner!.idxScans(index) : 0;
        const t0 = performance.now();
        const got = await listIds(term);
        const ms = performance.now() - t0;
        expect(got).toEqual(want);
        if (index) await planner!.expectScansAbove(index, before);
        expect(ms).toBeLessThan(400);
      }, 60_000);
    }

    it('customer search: a registered customer and a guest are found, the guest through its index', async () => {
      const regTerm = 'uf' + md5(tag + 'uf' + r).slice(0, 8);
      const guestTerm = 'ge' + md5(tag + 'ge' + g).slice(0, 8);
      const guests = await planner!.idxScans('orders_guest_email_trgm_idx');
      const reg = await planner!.inStore(storeId, () => searchOrderCustomers(storeId, regTerm));
      expect(reg.map(c => [c.isGuest, c.email])).toEqual([
        [false, `ru${md5(tag + 're' + r)}@x.test`],
      ]);
      const gst = await planner!.inStore(storeId, () => searchOrderCustomers(storeId, guestTerm));
      expect(gst.map(c => [c.isGuest, c.email])).toEqual([
        [true, `ge${md5(tag + 'ge' + g)}@x.test`],
      ]);
      await planner!.expectScansAbove('orders_guest_email_trgm_idx', guests);
    }, 60_000);
  }
);
