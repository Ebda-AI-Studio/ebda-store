/**
 * Order search: index-backed, same rows (issue 2405).
 *
 * The admin / Orders-PWA order search matched the order number and the
 * registered customer's name, email and phone through four
 * `customer: { is: ... }` relation filters. Prisma compiles those into LEFT
 * JOINs with an OR spanning both tables, which no index can serve — so every
 * search walked the store's whole order history. `orderSearchWhere` now
 * resolves the matching customers first and filters `orders` on
 * `order_number ILIKE` OR `customer_id IN (...)`, which the trigram + btree
 * indexes of migration 20261001140000 serve with a BitmapOr.
 *
 * Pinned here:
 *   - every index that migration adds exists after `migrate deploy`;
 *   - the rewritten WHERE returns EXACTLY the rows of the old relation-join
 *     shape, for every term class: order number, each customer field, a
 *     customer whose `users.store_id` is not the order's store, a term that
 *     is too short for a trigram, and a term broad enough to take the
 *     fallback — plus the store scope, soft-deleted orders and guest orders.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, Prisma } from '@force/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { OrderService, ORDER_SEARCH_CUSTOMER_ID_CAP } =
  await import('../../apps/api/src/services/order.service');

const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const tag = suffix.replace(/[^a-z0-9]/gi, '').slice(-10);

let storeId: string;
let otherStoreId: string;
let ownerId: string;
const userIds: string[] = [];

/** The pre-2405 shape: four relation filters. The reference for "same rows". */
function relationWhere(storeId: string, search: string): Prisma.OrderWhereInput {
  const contains = { contains: search, mode: 'insensitive' as const };
  return {
    storeId,
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

async function ids(where: Prisma.OrderWhereInput): Promise<string[]> {
  const rows = await prisma.order.findMany({ where, select: { id: true } });
  return rows.map(r => r.id).sort();
}

let seq = 0;
async function order(store: string, customerId?: string, deleted = false) {
  return prisma.order.create({
    data: {
      storeId: store,
      orderNumber: `OS-${tag}-${++seq}`,
      subtotal: 1000,
      total: 1000,
      customerId,
      shippingAddress: {},
      billingAddress: {},
      deletedAt: deleted ? new Date() : undefined,
    },
  });
}

describe.skipIf(!hasDb)('order search indexes (issue 2405)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `os-owner-${suffix}@x.test`,
        passwordHash: 'x',
        firstName: 'Os',
        lastName: 'Owner',
        role: 'store_admin',
      },
    });
    ownerId = owner.id;
    const [a, b] = await Promise.all(
      ['a', 'b'].map(k =>
        prisma.store.create({
          data: { name: `os-${k}-${suffix}`, slug: `os-${k}-${suffix}`, ownerId },
        })
      )
    );
    storeId = a.id;
    otherStoreId = b.id;

    const people: Array<[string, string, string, string | null, string | null]> = [
      // first, last, email, phone, users.store_id
      [`Zubaida${tag}`, 'Alenezi', `zub-${suffix}@x.test`, `+9655${tag.slice(-7)}`, storeId],
      ['Hamad', `Qurain${tag}`, `ham-${suffix}@x.test`, null, null],
      ['Noor', 'Alsabah', `noorbox${tag}-${suffix}@x.test`, null, otherStoreId],
    ];
    for (const [firstName, lastName, email, phone, sid] of people) {
      const u = await prisma.user.create({
        data: {
          firstName,
          lastName,
          email,
          phone,
          passwordHash: 'x',
          role: 'customer',
          storeId: sid,
        },
      });
      userIds.push(u.id);
    }
    const [zub, ham, noor] = userIds;
    await order(storeId, zub);
    await order(storeId, zub, true); // soft-deleted: never listed
    await order(storeId, ham); // customer with users.store_id NULL
    await order(storeId, noor); // customer registered on ANOTHER store
    await order(storeId); // guest
    await order(otherStoreId, zub); // other store: never in this store's search
  });

  afterAll(async () => {
    if (!storeId) return;
    await prisma.order.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.store.deleteMany({ where: { id: { in: [storeId, otherStoreId] } } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('migration 20261001140000 created every index it declares', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'orders_order_number_trgm_idx', 'users_first_name_trgm_idx',
        'users_last_name_trgm_idx', 'users_email_trgm_idx', 'users_phone_trgm_idx',
        'ai_usage_created_at_cached_hit_idx', 'cart_bundles_bundle_id_idx'
      )
      ORDER BY indexname
    `;
    expect(rows.map(r => r.indexname)).toEqual([
      'ai_usage_created_at_cached_hit_idx',
      'cart_bundles_bundle_id_idx',
      'orders_order_number_trgm_idx',
      'users_email_trgm_idx',
      'users_first_name_trgm_idx',
      'users_last_name_trgm_idx',
      'users_phone_trgm_idx',
    ]);
    for (const r of rows.filter(r => r.indexname.endsWith('_trgm_idx'))) {
      expect(r.indexdef).toMatch(/USING gin \(\w+ gin_trgm_ops\)/);
    }
  });

  it('the resolved-customer path is what serves an ordinary term', async () => {
    const where = await OrderService.listWhere(storeId, { search: `zubaida${tag}` });
    expect(JSON.stringify(where.OR)).toContain('"customerId":{"in":');
    expect(JSON.stringify(where.OR)).not.toContain('"customer":');
  });

  it.each([
    ['order number fragment', () => `OS-${tag}-1`],
    ['first name, any case', () => `ZUBAIDA${tag}`],
    ['last name of a customer with users.store_id NULL', () => `qurain${tag}`],
    ['email of a customer registered on another store', () => `noorbox${tag}`],
    ['phone', () => tag.slice(-7)],
    ['no match', () => `nothing-${tag}`],
    ['shorter than a trigram (relation fallback)', () => 'Os'],
  ])('%s: same rows as the relation-join shape', async (_label, term) => {
    const search = term();
    const expected = await ids(relationWhere(storeId, search));
    const actual = await ids(await OrderService.listWhere(storeId, { search }));
    expect(actual).toEqual(expected);
  });

  it('matches across the store only, never a soft-deleted or foreign order', async () => {
    const found = await ids(await OrderService.listWhere(storeId, { search: `zubaida${tag}` }));
    const zubInStore = await prisma.order.findMany({
      where: { storeId, customerId: userIds[0], deletedAt: null },
      select: { id: true },
    });
    expect(found).toEqual(zubInStore.map(o => o.id).sort());
  });

  it(`more than ${ORDER_SEARCH_CUSTOMER_ID_CAP} matching customers falls back to the relation filter, same rows`, async () => {
    const crowd = `crowd${tag}`;
    const created = await prisma.user.createManyAndReturn({
      data: Array.from({ length: ORDER_SEARCH_CUSTOMER_ID_CAP + 1 }, (_, i) => ({
        email: `${crowd}-${i}-${suffix}@x.test`,
        passwordHash: 'x',
        firstName: crowd,
        lastName: `c${i}`,
        role: 'customer' as const,
      })),
      select: { id: true },
    });
    userIds.push(...created.map(u => u.id));
    await prisma.order.createMany({
      data: created.map((u, i) => ({
        storeId,
        orderNumber: `OSC-${tag}-${i}`,
        subtotal: 1,
        total: 1,
        customerId: u.id,
        shippingAddress: {},
        billingAddress: {},
      })),
    });

    const where = await OrderService.listWhere(storeId, { search: crowd });
    expect(JSON.stringify(where.OR)).toContain('"customer":');
    const actual = await ids(where);
    expect(actual).toHaveLength(ORDER_SEARCH_CUSTOMER_ID_CAP + 1);
    expect(actual).toEqual(await ids(relationWhere(storeId, crowd)));
  });
});
