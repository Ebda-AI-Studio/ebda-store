/**
 * Search P2 Tasks 15-17: customer + order search in SQL, as `ebda_app` (the production role).
 *
 *  - Part 1 (small store, fixtures per run): the exact result of `matchingCustomers`,
 *    `searchOrderCustomers` (typeahead), `aggregateCustomersMatching` (list/export) and the admin
 *    order list (`orderSearchWhere`) for Arabic names, every Egyptian phone form, Arabic-Indic digits,
 *    guests, zero-order registered customers, email, order numbers by digits, LIKE metacharacters and
 *    a second store with the same names.
 *  - Part 2 (20k users / 20k guest orders): the four normalised expression indexes are scanned by
 *    the production lookup as `ebda_app` (idx_scan counters), the result is exact, and a customer
 *    OLDER than the cached aggregate's 20k-order scan window is still found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { createAppPlanner } from '../helpers/app-role-planner';

const { matchingCustomers } = await import('../../apps/api/src/services/admin-search.service');
const { searchOrderCustomers } =
  await import('../../apps/api/src/services/customer-search.service');
const { aggregateCustomersMatching } =
  await import('../../apps/api/src/services/customer-aggregate.service');
const { orderSearchWhere } = await import('../../apps/api/src/services/order.service');

const planner = hasDb ? createAppPlanner() : null;
const tag = `cs${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const ORDER_NO = String(100000 + Math.floor(Math.random() * 899999)); // 6 unique digits
const toArabicIndic = (s: string) => s.replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);

let A = '';
let B = '';
let ownerA = '';
let ownerB = '';
const ids = { u1: `${tag}-u1`, u2: `${tag}-u2`, ub: `${tag}-ub` };

const inA = <T>(fn: () => Promise<T>) => planner!.inStore(A, fn);
const sorted = (a: string[]) => [...a].sort();

describe.skipIf(!hasDb)('customers + orders search in SQL as ebda_app (Tasks 15-17)', () => {
  beforeAll(async () => {
    const mk = async (n: string) =>
      (
        await prisma.user.create({
          data: {
            email: `${tag}${n}@x.test`,
            passwordHash: 'x',
            firstName: 'Cs',
            lastName: n,
            role: 'store_admin',
          },
        })
      ).id;
    ownerA = await mk('a');
    ownerB = await mk('b');
    A = (await prisma.store.create({ data: { name: `${tag}a`, slug: `${tag}a`, ownerId: ownerA } }))
      .id;
    B = (await prisma.store.create({ data: { name: `${tag}b`, slug: `${tag}b`, ownerId: ownerB } }))
      .id;
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at) VALUES
        (${ids.u1}, ${A}, ${`ali.${tag}@x.test`}, 'x', 'أحمد', 'علي', '+201012345678', 'customer', now()),
        (${ids.u2}, ${A}, ${`sara.${tag}@x.test`}, 'x', 'سارة', 'حسن', '01155550000', 'customer', now()),
        (${ids.ub}, ${B}, ${`ahmed.${tag}@x.test`}, 'x', 'أحمد', 'علي', '+201012345678', 'customer', now())`;
    const ship = (o: object) => JSON.stringify(o);
    await prisma.$executeRaw`
      INSERT INTO public.orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at) VALUES
        (${`${tag}-o1`}, ${A}, ${`EB-${ORDER_NO}`}, 1000, 1000, '{}', '{}', ${ids.u1}, now()),
        (${`${tag}-g1`}, ${A}, ${`EB-${tag}-g1`}, 1000, 1000,
           ${ship({ firstName: 'منى', lastName: 'سالم', phone: '0112 345 6789', email: `mona.${tag}@x.test` })}::jsonb, '{}', NULL, now()),
        (${`${tag}-g2`}, ${A}, ${`EB-${tag}-g2`}, 1000, 1000,
           ${ship({ firstName: 'Karim', lastName: 'Adel', phone: '+201277770000', email: `karim.${tag}@x.test` })}::jsonb, '{}', NULL, now()),
        (${`${tag}-ob`}, ${B}, ${`EB-${tag}-ob`}, 1000, 1000, '{}', '{}', ${ids.ub}, now()),
        (${`${tag}-gb`}, ${B}, ${`EB-${tag}-gb`}, 1000, 1000,
           ${ship({ firstName: 'منى', lastName: 'سالم', phone: '0112 345 6789' })}::jsonb, '{}', NULL, now())`;
  }, 60_000);

  afterAll(async () => {
    for (const s of [A, B]) {
      if (!s) continue;
      await prisma.$executeRaw`DELETE FROM public.orders WHERE store_id = ${s}`;
      await prisma.$executeRaw`DELETE FROM public.users WHERE store_id = ${s}`;
      await prisma.store.delete({ where: { id: s } }).catch(() => undefined);
    }
    for (const u of [ownerA, ownerB])
      if (u) await prisma.user.delete({ where: { id: u } }).catch(() => undefined);
  }, 60_000);

  const g = (n: string) => `${tag}-${n}`;

  describe('matchingCustomers', () => {
    it.each([
      ['احمد', 'أحمد (alef folded)', { users: ['u1'], guests: [] }],
      ['أحمد علي', 'two tokens, both required', { users: ['u1'], guests: [] }],
      ['0101 234 5678', 'phone with spaces, stored +20…', { users: ['u1'], guests: [] }],
      ['+20 101 234 5678', 'phone with country code', { users: ['u1'], guests: [] }],
      ['00201012345678', 'phone with 0020', { users: ['u1'], guests: [] }],
      ['٠١٠١٢٣٤٥٦٧٨', 'phone in Arabic-Indic digits', { users: ['u1'], guests: [] }],
      ['سارة', 'zero-order registered customer', { users: ['u2'], guests: [] }],
      ['01155550000', 'zero-order customer by phone', { users: ['u2'], guests: [] }],
      ['منى', 'guest by name (shipping address only)', { users: [], guests: ['g1'] }],
      ['01123456789', 'guest phone stored as "0112 345 6789"', { users: [], guests: ['g1'] }],
      ['karim', 'guest, Latin, case-insensitive', { users: [], guests: ['g2'] }],
      ['KARIM ADEL', 'guest, two Latin tokens', { users: [], guests: ['g2'] }],
      [`karim.${tag}`, 'guest by email', { users: [], guests: ['g2'] }],
      [`sara.${tag}@x.test`, 'registered by email', { users: ['u2'], guests: [] }],
    ])('%s -> %s', async (q, _label, want) => {
      const m = await inA(() => matchingCustomers(A, q));
      expect(sorted(m.userIds)).toEqual(sorted(want.users.map(g)));
      expect(sorted(m.guestOrderIds)).toEqual(sorted(want.guests.map(g)));
    });

    it('LIKE metacharacters are literal: "%" and "_" match nothing', async () => {
      for (const q of ['%', '_', 'a%', '%%%']) {
        const m = await inA(() => matchingCustomers(A, q));
        expect([q, m.userIds, m.guestOrderIds]).toEqual([q, [], []]);
      }
    });

    it("another store's customers never come back (same names and phone in store B)", async () => {
      const m = await inA(() => matchingCustomers(A, 'احمد'));
      expect(m.userIds).not.toContain(ids.ub);
      expect(m.guestOrderIds).not.toContain(g('gb'));
      const mine = await inA(() => matchingCustomers(A, 'منى'));
      expect(mine.guestOrderIds).toEqual([g('g1')]);
    });

    it('a two-letter term (no trigram) is answered from the store set, with the same results', async () => {
      const m = await inA(() => matchingCustomers(A, 'عل'));
      expect(m.userIds).toEqual([ids.u1]);
    });
  });

  describe('typeahead (searchOrderCustomers)', () => {
    it('finds a registered customer, a zero-order one and a guest, each once', async () => {
      const reg = await inA(() => searchOrderCustomers(A, 'احمد'));
      expect(reg.map(c => [c.id, c.isGuest])).toEqual([[ids.u1, false]]);
      const zero = await inA(() => searchOrderCustomers(A, '٠١١٥٥٥٥٠٠٠٠'));
      expect(zero.map(c => c.id)).toEqual([ids.u2]);
      const guest = await inA(() => searchOrderCustomers(A, '0112 345 6789'));
      expect(guest.map(c => [c.isGuest, c.firstName])).toEqual([[true, 'منى']]);
    });
    it('"%" matches nothing', async () => {
      expect(await inA(() => searchOrderCustomers(A, '%'))).toEqual([]);
    });
  });

  describe('customers list / export aggregate (aggregateCustomersMatching)', () => {
    it('returns the matched customers with their order totals, same row shape as the list', async () => {
      const r = await inA(() => aggregateCustomersMatching(A, '0101 234 5678'));
      expect(r.customers.map(c => [c.id, c.isGuest, c.totalOrders])).toEqual([[ids.u1, false, 1]]);
      const z = await inA(() => aggregateCustomersMatching(A, 'سارة'));
      expect(z.customers.map(c => [c.id, c.totalOrders])).toEqual([[ids.u2, 0]]);
      const gst = await inA(() => aggregateCustomersMatching(A, 'منى'));
      expect(gst.customers.map(c => [c.isGuest, c.firstName, c.totalOrders])).toEqual([
        [true, 'منى', 1],
      ]);
      expect(r.orders.map(o => o.id)).toEqual([g('o1')]);
    });
    it('no match: an empty list, not the whole store', async () => {
      const r = await inA(() => aggregateCustomersMatching(A, 'zzzznomatch'));
      expect(r.customers).toEqual([]);
      expect(r.orders).toEqual([]);
    });
  });

  describe('admin order list search (orderSearchWhere)', () => {
    const list = (term: string) =>
      inA(async () => {
        const arms = await orderSearchWhere(A, term);
        const rows = await prisma.order.findMany({
          where: { storeId: A, deletedAt: null, OR: arms },
          select: { id: true },
        });
        return sorted(rows.map(r => r.id));
      });
    it.each([
      ['احمد', ['o1']],
      ['أحمد', ['o1']],
      ['0101 234 5678', ['o1']],
      ['+201012345678', ['o1']],
      ['منى', ['g1']],
      ['٠١١٢٣٤٥٦٧٨٩', ['g1']],
      [toArabicIndic(ORDER_NO), ['o1']],
      [`#${ORDER_NO}`, ['o1']],
      ['EB-' + ORDER_NO, ['o1']],
      ['KARIM', ['g2']],
    ])('%s finds %j', async (term, want) => {
      expect(await list(term)).toEqual(sorted(want.map(g)));
    });
    it('"%" returns no rows', async () => {
      expect(await list('%')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Part 2: index use as ebda_app at 20k rows, and the 20k-order scan window.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!hasDb)('normalised expression indexes are used as ebda_app (Task 15/16)', () => {
  const t2 = `${tag}p`;
  const USERS = 20_000;
  const ORDERS = 20_000;
  let S = '';
  let owner = '';
  const inS = <T>(fn: () => Promise<T>) => planner!.inStore(S, fn);

  beforeAll(async () => {
    owner = (
      await prisma.user.create({
        data: {
          email: `${t2}@x.test`,
          passwordHash: 'x',
          firstName: 'Cs',
          lastName: 'Big',
          role: 'store_admin',
        },
      })
    ).id;
    S = (await prisma.store.create({ data: { name: t2, slug: t2, ownerId: owner } })).id;
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at)
      SELECT ${t2} || '-u' || g, ${S}, 'ru' || md5(${t2} || 're' || g) || '@x.test', 'x',
             'احمد' || md5(${t2} || 'uf' || g), 'ul' || md5(${t2} || 'ul' || g),
             '+2012' || lpad(g::text, 8, '0'), 'customer', now()
      FROM generate_series(1, ${USERS}::int) g`;
    // the matching guest order is the OLDEST of the store; 20k newer ones push it out of the cached
    // aggregate's 20,000-order scan window
    await prisma.$executeRaw`
      INSERT INTO public.orders
        (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, created_at, updated_at)
      SELECT ${t2} || '-o' || g, ${S}, 'EB' || upper(md5(${t2} || 'o' || g)), 1000, 1000,
             jsonb_build_object('firstName', 'gf' || md5(${t2} || 'gf' || g), 'lastName', 'gl' || md5(${t2} || 'gl' || g),
               'email', 'ge' || md5(${t2} || 'ge' || g) || '@x.test', 'phone', '+2011' || lpad(g::text, 8, '0')),
             jsonb_build_object('note', repeat('x', 1200)), NULL,
             CASE WHEN g = 1 THEN timestamp '2020-01-01' ELSE now() END, now()
      FROM generate_series(1, ${ORDERS + 1}::int) g`;
    await prisma.$executeRaw`ANALYZE public.orders`;
    await prisma.$executeRaw`ANALYZE public.users`;
  }, 240_000);

  afterAll(async () => {
    if (S) {
      await prisma.$executeRaw`DELETE FROM public.orders WHERE store_id = ${S}`;
      await prisma.$executeRaw`DELETE FROM public.users WHERE store_id = ${S}`;
      await prisma.store.delete({ where: { id: S } }).catch(() => undefined);
    }
    if (owner) await prisma.user.delete({ where: { id: owner } }).catch(() => undefined);
    await planner?.close();
  }, 240_000);

  const u = 4321; // a registered customer
  const gst = 7777; // a guest order
  const cases: Array<[string, string, string, 'user' | 'guest']> = [
    [
      'registered name (Arabic, normalised)',
      'users_name_norm_trgm_idx',
      `أحمد${md5(t2 + 'uf' + u)}`,
      'user',
    ],
    [
      'registered phone (digits)',
      'users_phone_digits_trgm_idx',
      `0 12 ${String(u).padStart(8, '0')}`,
      'user',
    ],
    [
      'guest name',
      'orders_guest_name_norm_trgm_idx',
      `gf${md5(t2 + 'gf' + gst)} gl${md5(t2 + 'gl' + gst)}`,
      'guest',
    ],
    [
      'guest phone (digits)',
      'orders_guest_phone_digits_trgm_idx',
      `+2011${String(gst).padStart(8, '0')}`,
      'guest',
    ],
  ];

  for (const [label, index, term, kind] of cases) {
    it(`${label} is index-backed and exact as ebda_app (${index})`, async () => {
      const before = await planner!.idxScans(index);
      const t0 = performance.now();
      const m = await inS(() => matchingCustomers(S, term));
      const ms = performance.now() - t0;
      if (kind === 'user') {
        expect(m.userIds).toEqual([`${t2}-u${u}`]);
      } else {
        expect(m.guestOrderIds).toEqual([`${t2}-o${gst}`]);
      }
      await planner!.expectScansAbove(index, before);
      expect(ms).toBeLessThan(500);
    }, 60_000);
  }

  it('a customer older than the cached aggregate 20k-order window is still found', async () => {
    const r = await inS(() => aggregateCustomersMatching(S, `gf${md5(t2 + 'gf' + 1)}`));
    expect(r.customers.map(c => [c.isGuest, c.totalOrders])).toEqual([[true, 1]]);
    expect(r.orders.map(o => o.id)).toEqual([`${t2}-o1`]);
  }, 60_000);
});
