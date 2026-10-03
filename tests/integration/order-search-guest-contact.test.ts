/**
 * Order search matches GUEST orders by the buyer's contact (index-audit
 * recommendation 3, approved 2026-10-03).
 *
 * 174 of 188 production orders are guest orders: `customer_id IS NULL`, the
 * buyer's name / email / phone only in the `shipping_address` JSON snapshot.
 * The order search used to match registered customers only, so a merchant
 * could not find a guest order by the guest's name or phone. It now matches
 * `shipping_address ->> firstName | lastName | email | phone` on guest orders,
 * served by four partial expression trigram indexes (migration
 * 20261003100000_order_search_guest_contact_trgm_idx).
 *
 * Pinned here:
 *   - the four indexes exist, are GIN trigram, expression-based and partial on
 *     `customer_id IS NULL`;
 *   - for every term class the search returns EXACTLY: the pre-change
 *     relation-join rows (registered customers + order number — unchanged)
 *     UNION the guest orders whose contact contains the term (computed here in
 *     plain JS, independent of the SQL under test);
 *   - a registered customer's order is never matched through its shipping JSON;
 *   - store scope, soft-deleted orders, LIKE metacharacters, the short-term and
 *     over-cap fallbacks;
 *   - the real statement is index-eligible: with seq scans disabled its plan
 *     uses the guest trigram indexes. A rewrite to a different JSON expression,
 *     or one that drops `customer_id IS NULL`, cannot use them and reddens this.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, Prisma } from '@force/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { OrderService, ORDER_SEARCH_CUSTOMER_ID_CAP, guestOrderIdsSql } =
  await import('../../apps/api/src/services/order.service');

const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const tag = suffix.replace(/[^a-z0-9]/gi, '').slice(-10);

let storeId: string;
let otherStoreId: string;
let ownerId: string;
let regUserId: string;

/** The pre-change shape (order number + registered customer). Reference for "registered unchanged". */
function relationWhere(store: string, search: string): Prisma.OrderWhereInput {
  const contains = { contains: search, mode: 'insensitive' as const };
  return {
    storeId: store,
    deletedAt: null,
    OR: [
      { orderNumber: contains },
      { customer: { is: { firstName: contains } } },
      { customer: { is: { lastName: contains } } },
      { customer: { is: { email: contains } } },
      { customer: { is: { phone: contains } } },
    ],
  };
}

/** Plain-JS oracle for the guest arm: live guest orders of the store whose contact contains the term. */
async function guestOracle(store: string, search: string): Promise<string[]> {
  const needle = search.toLowerCase();
  const rows = await prisma.order.findMany({
    where: { storeId: store, customerId: null, deletedAt: null },
    select: { id: true, shippingAddress: true },
  });
  return rows
    .filter(r => {
      const a = (r.shippingAddress ?? {}) as Record<string, unknown>;
      return ['firstName', 'lastName', 'email', 'phone'].some(
        k => typeof a[k] === 'string' && (a[k] as string).toLowerCase().includes(needle)
      );
    })
    .map(r => r.id);
}

async function expected(search: string): Promise<string[]> {
  const registered = await prisma.order.findMany({
    where: relationWhere(storeId, search),
    select: { id: true },
  });
  const all = new Set([...registered.map(r => r.id), ...(await guestOracle(storeId, search))]);
  return [...all].sort();
}

async function actual(search: string): Promise<string[]> {
  const where = await OrderService.listWhere(storeId, { search });
  const rows = await prisma.order.findMany({ where, select: { id: true } });
  return rows.map(r => r.id).sort();
}

let seq = 0;
async function order(
  store: string,
  contact: Record<string, string>,
  opts: { customerId?: string; deleted?: boolean } = {}
) {
  return prisma.order.create({
    data: {
      storeId: store,
      orderNumber: `OG-${tag}-${++seq}`,
      subtotal: 1000,
      total: 1000,
      customerId: opts.customerId,
      shippingAddress: contact,
      billingAddress: {},
      deletedAt: opts.deleted ? new Date() : undefined,
    },
  });
}

describe.skipIf(!hasDb)('order search: guest contact', () => {
  const guestIds: Record<string, string> = {};

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `og-owner-${suffix}@x.test`,
        passwordHash: 'x',
        firstName: 'Og',
        lastName: 'Owner',
        role: 'store_admin',
      },
    });
    ownerId = owner.id;
    const [a, b] = await Promise.all(
      ['a', 'b'].map(k =>
        prisma.store.create({
          data: { name: `og-${k}-${suffix}`, slug: `og-${k}-${suffix}`, ownerId },
        })
      )
    );
    storeId = a.id;
    otherStoreId = b.id;

    const reg = await prisma.user.create({
      data: {
        email: `regcust${tag}-${suffix}@x.test`,
        passwordHash: 'x',
        firstName: `Regina${tag}`,
        lastName: 'Registered',
        role: 'customer',
      },
    });
    regUserId = reg.id;

    guestIds.byFirst = (
      await order(storeId, {
        firstName: `Gwendolyn${tag}`,
        lastName: 'Plain',
        phone: '+96550000001',
      })
    ).id;
    guestIds.byLast = (await order(storeId, { firstName: 'Plain', lastName: `Okonkwo${tag}` })).id;
    guestIds.byEmail = (
      await order(storeId, { firstName: 'Plain', email: `Mixed.Case${tag}@Mail.test` })
    ).id;
    guestIds.byPhone = (
      await order(storeId, { firstName: 'Plain', phone: `+9659${tag.slice(-7)}` })
    ).id;
    guestIds.wild = (await order(storeId, { firstName: `100%_${tag}` })).id;
    guestIds.noContact = (await order(storeId, {})).id;
    // Must NEVER match: soft-deleted, other store.
    await order(storeId, { firstName: `Gwendolyn${tag}` }, { deleted: true });
    await order(otherStoreId, { firstName: `Gwendolyn${tag}` });
    // A REGISTERED customer's order whose shipping JSON carries the term but whose
    // account does not: it must not be found through the JSON (unchanged behaviour).
    guestIds.regViaJson = (
      await order(
        storeId,
        { firstName: `Jsonly${tag}`, phone: '+96551111111' },
        { customerId: regUserId }
      )
    ).id;
    // A registered customer's order that matches through the account, as before.
    guestIds.regViaAccount = (await order(storeId, {}, { customerId: regUserId })).id;
  });

  afterAll(async () => {
    if (!storeId) return;
    await prisma.order.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
    await prisma.user.deleteMany({ where: { id: regUserId } });
    await prisma.store.deleteMany({ where: { id: { in: [storeId, otherStoreId] } } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('migration 20261003100000 created four partial expression trigram indexes', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'orders\\_guest\\_%\\_trgm\\_idx'
      ORDER BY indexname
    `;
    expect(rows.map(r => r.indexname)).toEqual([
      'orders_guest_email_trgm_idx',
      'orders_guest_first_name_trgm_idx',
      'orders_guest_last_name_trgm_idx',
      'orders_guest_phone_trgm_idx',
    ]);
    const keyOf: Record<string, string> = {
      orders_guest_email_trgm_idx: 'email',
      orders_guest_first_name_trgm_idx: 'firstName',
      orders_guest_last_name_trgm_idx: 'lastName',
      orders_guest_phone_trgm_idx: 'phone',
    };
    for (const r of rows) {
      expect(r.indexdef).toMatch(/USING gin/);
      expect(r.indexdef).toContain(`(shipping_address ->> '${keyOf[r.indexname]}'::text)`);
      expect(r.indexdef).toContain('gin_trgm_ops');
      expect(r.indexdef).toMatch(/WHERE \(customer_id IS NULL\)/);
    }
  });

  it.each([
    ['guest first name, any case', () => `GWENDOLYN${tag}`],
    ['guest last name', () => `okonkwo${tag}`],
    ['guest email fragment, any case', () => `mixed.case${tag}`],
    ['guest phone fragment', () => tag.slice(-7)],
    ['LIKE metacharacters are literal', () => `100%_${tag}`],
    ['a _ is not a wildcard', () => `Gwendolyn_${tag}`],
    [
      'a _ inside the term is not a one-char wildcard',
      () => `Gwendolyn${tag.slice(0, 3)}_${tag.slice(4)}`,
    ],
    ['a % inside the term is not a wildcard', () => `Gwendolyn%${tag}`],
    ['a registered account field', () => `regina${tag}`],
    ['a term only in a registered order shipping JSON', () => `jsonly${tag}`],
    ['an order number', () => `OG-${tag}-1`],
    ['no match', () => `nothing-${tag}`],
    ['shorter than a trigram (JSON-filter fallback)', () => 'Pl'],
    ['shorter than a trigram, only in a registered order JSON', () => 'Js'],
    ['a lone % (JSON-filter fallback) is literal', () => '%'],
  ])('%s: relation-join rows (unchanged) plus the guest oracle', async (_l, term) => {
    const search = term();
    expect(await actual(search)).toEqual(await expected(search));
  });

  it('finds each guest order by name, phone and email, and nothing it should not', async () => {
    expect(await actual(`gwendolyn${tag}`)).toEqual([guestIds.byFirst]);
    expect(await actual(`okonkwo${tag}`)).toEqual([guestIds.byLast]);
    expect(await actual(`mixed.case${tag}`)).toEqual([guestIds.byEmail]);
    expect(await actual(tag.slice(-7))).toContain(guestIds.byPhone);
    expect(await actual(`100%_${tag}`)).toEqual([guestIds.wild]);
    // `_` must not stand for "any character": no order holds "Gwendolyn?<tag>".
    expect(await actual(`Gwendolyn_${tag}`)).toEqual([]);
    expect(await actual(`Gwendolyn%${tag}`)).toEqual([]);
    expect(await actual(`Gwendolyn${tag.slice(0, 3)}_${tag.slice(4)}`)).toEqual([]);
  });

  it("a registered customer's order is not matched through its shipping JSON", async () => {
    expect(await actual(`jsonly${tag}`)).toEqual([]);
    expect(await actual(`regina${tag}`)).toEqual(
      [guestIds.regViaJson, guestIds.regViaAccount].sort()
    );
  });

  it('serves an ordinary term with the resolved-id arm, not the JSON filter', async () => {
    const where = await OrderService.listWhere(storeId, { search: `gwendolyn${tag}` });
    expect(JSON.stringify(where.OR)).toContain(`"id":{"in":["${guestIds.byFirst}"]}`);
    expect(JSON.stringify(where.OR)).not.toContain('string_contains');
  });

  it(`more than ${ORDER_SEARCH_CUSTOMER_ID_CAP} matching guest orders degrades ONLY the guest half; the registered customer arm survives (issue 2444), same rows`, async () => {
    // Unique per ATTEMPT, not per file: CI runs this with `--retry=1`, which re-runs the test body
    // against the same database while `beforeAll` is not re-run. The per-file `tag` made attempt 2
    // collide with attempt 1's orders (unique `order_number`) so the reported failure was attempt
    // 2's P2002, not attempt 1's real one (issue 2445). `run` is in the order numbers, the user
    // email and the search term; the `finally` removes this attempt's rows even when it fails.
    const run = Math.random().toString(36).slice(2, 8);
    const crowd = `crowd${tag}${run}`;
    const user = await prisma.user.create({
      data: {
        email: `${crowd}@x.test`,
        passwordHash: 'x',
        firstName: crowd,
        lastName: 'Registered',
        role: 'customer',
      },
    });
    try {
      await prisma.order.createMany({
        data: Array.from({ length: ORDER_SEARCH_CUSTOMER_ID_CAP + 1 }, (_, i) => ({
          storeId,
          orderNumber: `OGC-${tag}-${run}-${i}`,
          subtotal: 1,
          total: 1,
          shippingAddress: { firstName: crowd, lastName: `c${i}` },
          billingAddress: {},
        })),
      });
      const regOrder = await order(storeId, {}, { customerId: user.id });

      const where = await OrderService.listWhere(storeId, { search: crowd });
      const arms = JSON.stringify(where.OR);
      // The guest half is over the cap -> the JSON filter ...
      expect(arms).toContain('string_contains');
      // ... but the registered half keeps its indexed `customer_id IN (...)` arm, not the
      // four-LEFT-JOIN relation filter.
      expect(arms).toContain(`"customerId":{"in":["${user.id}"]}`);
      expect(arms).not.toContain('"customer":');

      const got = await actual(crowd);
      expect(got).toHaveLength(ORDER_SEARCH_CUSTOMER_ID_CAP + 2);
      expect(got).toContain(regOrder.id);
      expect(got).toEqual(await expected(crowd));
    } finally {
      await prisma.order.deleteMany({
        where: { storeId, orderNumber: { startsWith: `OGC-${tag}-${run}-` } },
      });
      await prisma.order.deleteMany({ where: { customerId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it('the real statement is index-eligible: with every other index on orders removed, its plan is a BitmapOr of the guest trigram indexes', async () => {
    // Which plan a planner CHOOSES depends on table size and statistics, so a
    // cost-based assertion is flaky (it flipped between runs of this file and
    // of the whole suite). Eligibility is not cost: remove the competing
    // indexes (rolled back below), forbid a seq scan, and the statement either
    // can use the guest indexes or it has nothing to scan with. A rewrite to a
    // different JSON expression, or one without `customer_id IS NULL`, cannot
    // prove the partial predicate and falls to a Seq Scan, which reddens this.
    const ROLLBACK = new Error('rollback');
    let plan = '';
    await prisma
      .$transaction(async tx => {
        const others = await tx.$queryRaw<Array<{ relname: string }>>`
          SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'public.orders'::regclass AND NOT i.indisprimary
            AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
            AND c.relname NOT LIKE 'orders\\_guest\\_%'`;
        for (const { relname } of others) {
          await tx.$executeRawUnsafe(`DROP INDEX public."${relname}"`);
        }
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
          Prisma.sql`EXPLAIN (COSTS OFF) ${guestOrderIdsSql(storeId, `zq${tag.slice(-6)}`)}`
        );
        plan = rows.map(r => r['QUERY PLAN']).join('\n');
        throw ROLLBACK;
      })
      .catch(e => {
        if (e !== ROLLBACK) throw e;
      });
    for (const idx of ['first_name', 'last_name', 'email', 'phone']) {
      expect(plan).toContain(`orders_guest_${idx}_trgm_idx`);
    }
    expect(plan).toContain('BitmapOr');
    expect(plan).not.toContain('Seq Scan');
  });
});
