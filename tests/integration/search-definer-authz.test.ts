/**
 * Security review (Task 14): the SECURITY DEFINER id lookups `ebda_product_search_ids` and
 * `ebda_order_search_ids` run as the table owner, so they ignore RLS. They must therefore NOT be a
 * search oracle ("does phone X exist anywhere?"):
 *   - the store comes ONLY from the scoped session (`app.current_store_id`); no scope = refused,
 *     an argument naming another store = empty (indistinguishable from "no match");
 *   - they return ids only, never data or counts, and apply the visibility the RLS policies and the
 *     app layer apply: soft-deleted rows, and users the `users` policy would hide;
 *   - EXECUTE for ebda_app only, search_path pinned.
 * Every case runs as `ebda_app` (the production role) through the planner helper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { createAppPlanner } from '../helpers/app-role-planner';

const planner = hasDb ? createAppPlanner() : null;
const tag = `az${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const w = (s: string) => `${tag}${s}`; // unique, lower-case, 3+ chars
let A = '';
let B = '';
let ownerA = '';
let ownerB = '';

type Row = { id: string };

describe.skipIf(!hasDb)('search definers are not an oracle (security review)', () => {
  const asScope = <T>(scope: string | null, fn: () => Promise<T>) =>
    scope ? planner!.inStore(scope, fn) : planner!.asApp(fn);
  const ids = async (scope: string | null, fn: () => Promise<Row[]>) =>
    (await asScope(scope, fn)).map(r => r.id).filter(Boolean);

  beforeAll(async () => {
    const mk = async (n: string) =>
      (
        await prisma.user.create({
          data: {
            email: `${tag}${n}@x.test`,
            passwordHash: 'x',
            firstName: 'Az',
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
      INSERT INTO public.products (id, store_id, name, slug, price, status, updated_at, deleted_at) VALUES
        (${w('pa-live')}, ${A}, ${w('alpha live')}, ${w('pa-live')}, 1, 'active', now(), NULL),
        (${w('pa-gone')}, ${A}, ${w('alpha gone')}, ${w('pa-gone')}, 1, 'active', now(), now()),
        (${w('pb-live')}, ${B}, ${w('bravo only')}, ${w('pb-live')}, 1, 'active', now(), NULL)`;
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at) VALUES
        (${w('u-a')}, ${A}, ${w('ua@x.test')}, 'x', ${w('cust a')}, 'x', '+201000000001', 'customer', now()),
        (${w('u-b')}, ${B}, ${w('ub@x.test')}, 'x', ${w('cust b')}, 'x', '+201000000002', 'customer', now())`;
    await prisma.$executeRaw`
      INSERT INTO public.orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at, deleted_at) VALUES
        (${w('oa-live')}, ${A}, ${w('ONA-LIVE')}, 1, 1, ${JSON.stringify({ firstName: w('guesta'), phone: '+201111111111' })}::jsonb, '{}', NULL, now(), NULL),
        (${w('oa-gone')}, ${A}, ${w('ONA-GONE')}, 1, 1, ${JSON.stringify({ firstName: w('guestgone') })}::jsonb, '{}', NULL, now(), now()),
        (${w('oa-ca')}, ${A}, ${w('ONA-CA')}, 1, 1, '{}', '{}', ${w('u-a')}, now(), NULL),
        (${w('oa-cb')}, ${A}, ${w('ONA-CB')}, 1, 1, '{}', '{}', ${w('u-b')}, now(), NULL),
        (${w('ob-live')}, ${B}, ${w('ONB-LIVE')}, 1, 1, ${JSON.stringify({ firstName: w('guestb'), phone: '+201222222222' })}::jsonb, '{}', NULL, now(), NULL)`;
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
    await planner?.close();
  }, 60_000);

  const P = (pattern: string, scope: string | null, ask: string, del = false) =>
    ids(
      scope,
      () =>
        prisma.$queryRaw<
          Row[]
        >`SELECT public.ebda_product_search_ids(${ask}, 'name', false, false, ${del}, false, ARRAY[${pattern}]::text[]) AS id`
    );
  const O = (kind: string, pattern: string, scope: string | null, ask: string) =>
    ids(
      scope,
      () =>
        prisma.$queryRaw<
          Row[]
        >`SELECT public.ebda_order_search_ids(${ask}, ${kind}, ${pattern}, 100) AS id`
    );

  it("positive control: each definer finds the scoped store's own rows", async () => {
    expect(await P(`%${w('alpha')}%`, A, A)).toEqual([w('pa-live')]);
    expect(await O('order_number', `%${w('ona-live')}%`, A, A)).toEqual([w('oa-live')]);
    expect(await O('guest', `%${w('guesta')}%`, A, A)).toEqual([w('oa-live')]);
  });

  it('cross-store probe returns nothing and looks exactly like "no match"', async () => {
    // scoped to A, naming B's id
    expect(await P(`%${w('bravo')}%`, A, B)).toEqual([]);
    expect(await O('guest', `%${w('guestb')}%`, A, B)).toEqual([]);
    // scoped to A, naming A, but the term exists only in B: identical to a term that exists nowhere
    const nowhere = `%${w('nowhere')}%`;
    expect(await P(`%${w('bravo')}%`, A, A)).toEqual(await P(nowhere, A, A));
    expect(await O('guest', '%201222222222%', A, A)).toEqual(await O('guest', nowhere, A, A));
    expect(await O('order_number', `%${w('onb-live')}%`, A, A)).toEqual([]);
    expect(await O('customers', `%${w('cust b')}%`, B, A)).toEqual([]); // scoped to B asking A
  });

  it('no store scope: refused (not an empty answer)', async () => {
    await expect(P(`%${w('alpha')}%`, null, A)).rejects.toThrow(/store scope|42501|permission/i);
    await expect(O('guest', `%${w('guesta')}%`, null, A)).rejects.toThrow(
      /store scope|42501|permission/i
    );
  });

  it('an owner session with no store scope is refused too (the scope is the only source of the store)', async () => {
    await expect(
      prisma.$queryRaw`SELECT public.ebda_product_search_ids(${A}, 'name', false, false, false, false, ARRAY['%a%']::text[])`
    ).rejects.toThrow(/store scope|42501|permission/i);
  });

  it('soft-deleted rows are not returned', async () => {
    expect(await P(`%${w('alpha')}%`, A, A, false)).toEqual([w('pa-live')]);
    expect(await O('order_number', `%${w('ona-gone')}%`, A, A)).toEqual([]);
    expect(await O('guest', `%${w('guestgone')}%`, A, A)).toEqual([]);
  });

  it('a customer the users policy hides (registered on another store) is not returned, even with an order here', async () => {
    expect(await O('customers', `%${w('cust a')}%`, A, A)).toEqual([w('u-a')]);
    expect(await O('customers', `%${w('cust b')}%`, A, A)).toEqual([]);
  });

  it('EXECUTE is for ebda_app only and the search_path is pinned', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ proname: string; secdef: boolean; cfg: string[] | null; pub: boolean; app: boolean }>
    >`
      SELECT p.proname::text AS proname, p.prosecdef AS secdef, p.proconfig AS cfg,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('ebda_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p WHERE p.proname IN ('ebda_product_search_ids', 'ebda_order_search_ids')
      ORDER BY 1`;
    expect(rows.map(r => r.proname)).toEqual(['ebda_order_search_ids', 'ebda_product_search_ids']);
    for (const r of rows) {
      expect(r.secdef).toBe(true);
      expect(r.pub).toBe(false);
      expect(r.app).toBe(true);
      expect(r.cfg).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });
});
