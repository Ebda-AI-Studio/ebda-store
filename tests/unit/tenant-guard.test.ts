/**
 * Code-level tenant guard (R-EBDA-003): `assertTenantScoped` / `assertRawScoped`, the pure
 * checks the Prisma query extension runs before EVERY query on an app client.
 *
 * Each operation type, nested writes, the identity and Store rules, the named hatches and the
 * raw-SQL policy (R-EBDA-004). The extension wiring itself (that the factory installs it and that
 * it sees the ambient context) is proven against a real ebda_app login in
 * tests/integration/tenant-guard-ebda-app.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  assertTenantScoped,
  assertRawScoped,
  guardedTablesIn,
  rawSqlText,
  TenantScopeViolation,
} from '../../packages/database/src/tenant-guard';
import type { AmbientScope } from '../../packages/database/src/tenant-scope';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const inA: AmbientScope = { storeId: A };
const none: AmbientScope = {};

const ok = (model: string, op: string, args: unknown, scope: AmbientScope) =>
  expect(() => assertTenantScoped(model, op, args, scope)).not.toThrow();
const refused = (model: string, op: string, args: unknown, scope: AmbientScope, why?: RegExp) => {
  let err: unknown;
  try {
    assertTenantScoped(model, op, args, scope);
  } catch (e) {
    err = e;
  }
  expect(err, `${model}.${op} should be refused`).toBeInstanceOf(TenantScopeViolation);
  if (why) expect(String((err as Error).message)).toMatch(why);
};

describe('tenant model: where-scoped operations', () => {
  const ops = [
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'delete',
    'deleteMany',
  ];
  for (const op of ops) {
    it(`${op}: storeId = ambient passes; missing, other store, or no context is refused`, () => {
      ok('Product', op, { where: { id: 'p', storeId: A } }, inA);
      refused('Product', op, { where: { id: 'p' } }, inA, /not scoped/);
      refused('Product', op, { where: { id: 'p', storeId: B } }, inA, /cross-store/);
      refused('Product', op, { where: { id: 'p', storeId: A } }, none, /no ambient store/);
    });
  }

  it('accepts storeId as { equals }, an all-ambient { in }, an AND member and a compound unique key', () => {
    ok('Product', 'findMany', { where: { storeId: { equals: A } } }, inA);
    ok('Product', 'findMany', { where: { storeId: { in: [A, A] } } }, inA);
    ok('Product', 'findMany', { where: { AND: [{ status: 'active' }, { storeId: A }] } }, inA);
    ok('Product', 'findMany', { where: { AND: { storeId: A } } }, inA);
    ok('Category', 'findUnique', { where: { storeId_slug: { storeId: A, slug: 'x' } } }, inA);
  });

  it('refuses a storeId that proves nothing or names another store anywhere', () => {
    refused('Product', 'findMany', { where: { storeId: { not: B } } }, inA);
    refused('Product', 'findMany', { where: { storeId: { in: [A, B] } } }, inA, /cross-store/);
    refused(
      'Product',
      'findMany',
      { where: { storeId: A, AND: [{ storeId: B }] } },
      inA,
      /cross-store/
    );
    refused('Product', 'findMany', { where: { OR: [{ storeId: A }, { storeId: B }] } }, inA);
    refused('Category', 'findUnique', { where: { storeId_slug: { storeId: B, slug: 'x' } } }, inA);
    refused('Product', 'findMany', {}, inA);
    refused('Product', 'findMany', undefined, inA);
  });

  it('an update may not move a row to another store', () => {
    ok('Product', 'update', { where: { id: 'p', storeId: A }, data: { storeId: A } }, inA);
    refused(
      'Product',
      'update',
      { where: { id: 'p', storeId: A }, data: { storeId: B } },
      inA,
      /another store/
    );
    refused(
      'Product',
      'updateMany',
      { where: { storeId: A }, data: { store: { connect: { id: B } } } },
      inA,
      /another store/
    );
  });

  it('an unknown operation fails closed', () => {
    refused('Product', 'findRaw', { where: { storeId: A } }, inA, /unknown operation/);
  });
});

describe('tenant model: creates', () => {
  it('create / createMany / createManyAndReturn need storeId (or store.connect) = ambient', () => {
    ok('Product', 'create', { data: { storeId: A, name: 'x' } }, inA);
    ok('Product', 'create', { data: { store: { connect: { id: A } }, name: 'x' } }, inA);
    ok('Product', 'createMany', { data: [{ storeId: A }, { storeId: A }] }, inA);
    ok('Product', 'createManyAndReturn', { data: { storeId: A } }, inA);
    refused('Product', 'create', { data: { name: 'x' } }, inA, /does not set storeId/);
    refused('Product', 'create', { data: { storeId: B } }, inA, /another store/);
    refused('Product', 'createMany', { data: [{ storeId: A }, { storeId: B }] }, inA);
    refused('Product', 'createMany', { data: [{ storeId: A }, {}] }, inA);
    refused('Product', 'create', { data: { storeId: A } }, none);
  });

  it('upsert checks where, create and update', () => {
    ok(
      'Customer',
      'upsert',
      { where: { id: 'c', storeId: A }, create: { storeId: A }, update: {} },
      inA
    );
    refused('Customer', 'upsert', { where: { id: 'c' }, create: { storeId: A }, update: {} }, inA);
    refused(
      'Customer',
      'upsert',
      { where: { id: 'c', storeId: A }, create: { storeId: B }, update: {} },
      inA
    );
    refused(
      'Customer',
      'upsert',
      { where: { id: 'c', storeId: A }, create: { storeId: A }, update: { storeId: B } },
      inA
    );
  });
});

describe('nested writes', () => {
  it('a nested create into a tenant model may not name another store', () => {
    ok('Order', 'create', { data: { storeId: A, events: { create: { storeId: A } } } }, inA);
    ok('Order', 'create', { data: { storeId: A, events: { create: [{ note: 'x' }] } } }, inA);
    refused(
      'Order',
      'create',
      { data: { storeId: A, events: { create: { storeId: B } } } },
      inA,
      /nested/
    );
    refused(
      'Order',
      'update',
      {
        where: { id: 'o', storeId: A },
        data: { events: { createMany: { data: [{ storeId: B }] } } },
      },
      inA,
      /nested/
    );
    refused(
      'Order',
      'update',
      {
        where: { id: 'o', storeId: A },
        data: {
          items: {
            create: {
              product: { connectOrCreate: { where: { id: 'p' }, create: { storeId: B } } },
            },
          },
        },
      },
      inA,
      /nested/
    );
  });

  it('a non-tenant model is still checked for nested tenant writes', () => {
    refused(
      'Plan',
      'update',
      { where: { code: 'x' }, data: { subscriptions: { create: { storeId: B } } } },
      inA
    );
    ok('Plan', 'findMany', {}, none);
  });
});

describe('identity models (User, StoreStaff)', () => {
  it('scoped to the ambient store OR keyed to the ambient user', () => {
    ok('User', 'findMany', { where: { storeId: A } }, inA);
    ok('User', 'findUnique', { where: { id: U } }, { userId: U });
    ok('StoreStaff', 'findMany', { where: { userId: U } }, { userId: U });
    refused('User', 'findUnique', { where: { id: 'someone-else' } }, { userId: U });
    refused('User', 'findMany', { where: { email: 'x@y' } }, none);
    refused('User', 'findMany', { where: { storeId: B } }, { storeId: A, userId: U });
  });

  it("create: a customer of the ambient store or the ambient user's own row", () => {
    ok('User', 'create', { data: { storeId: A, email: 'x' } }, inA);
    ok('User', 'create', { data: { id: U, storeId: null, email: 'x' } }, { userId: U });
    refused('User', 'create', { data: { id: 'other', email: 'x' } }, { userId: U });
    refused('User', 'create', { data: { storeId: B, email: 'x' } }, { storeId: A, userId: U });
  });

  it('the platform-operator hatch opens identity models but NOT store-scoped tenant tables', () => {
    const op: AmbientScope = { userId: U, hatch: 'platform-operator' };
    ok('User', 'findMany', { where: { role: 'store_admin' } }, op);
    ok('StoreStaff', 'findMany', {}, op);
    refused('Order', 'findMany', {}, op);
    refused('Product', 'count', { where: { status: 'active' } }, op);
  });
});

describe('Store (tenant root)', () => {
  it('by the ambient store id, or owned by the ambient user', () => {
    ok('Store', 'findUnique', { where: { id: A } }, inA);
    ok('Store', 'update', { where: { id: A }, data: { name: 'x' } }, inA);
    ok('Store', 'findMany', { where: { ownerId: U, deletedAt: null } }, { userId: U });
    ok('Store', 'count', { where: { ownerId: U } }, { userId: U });
    refused('Store', 'findUnique', { where: { id: B } }, inA, /not the ambient store/);
    refused('Store', 'findUnique', { where: { slug: 'shop' } }, none, /SECURITY DEFINER/);
    refused('Store', 'findMany', { where: { status: 'active' } }, inA);
    refused('Store', 'findMany', { where: { ownerId: 'other' } }, { userId: U });
  });

  it('a new store must be owned by the ambient user (or created by the operator)', () => {
    ok('Store', 'create', { data: { ownerId: U, slug: 's' } }, { userId: U });
    ok('Store', 'create', { data: { owner: { connect: { id: U } }, slug: 's' } }, { userId: U });
    refused('Store', 'create', { data: { ownerId: 'other', slug: 's' } }, { userId: U });
    refused('Store', 'create', { data: { ownerId: U, slug: 's' } }, none);
    ok(
      'Store',
      'create',
      { data: { ownerId: 'merchant', slug: 's' } },
      { userId: U, hatch: 'platform-operator' }
    );
    ok(
      'Store',
      'findMany',
      { where: { status: 'active' } },
      { userId: U, hatch: 'platform-operator' }
    );
  });
});

describe('tenant child models (no storeId column)', () => {
  it('need an ambient store', () => {
    ok('OrderItem', 'findMany', { where: { orderId: 'o' } }, inA);
    ok('ProductVariant', 'update', { where: { id: 'v' }, data: { inventory: 1 } }, inA);
    refused('OrderItem', 'findMany', { where: { orderId: 'o' } }, none, /ambient store/);
    refused('ProductVariant', 'findMany', {}, { userId: U });
  });
});

describe('owner-role-tx hatch', () => {
  it('allows everything (the role was proven to bypass RLS)', () => {
    const owner: AmbientScope = { hatch: 'owner-role-tx' };
    ok('Product', 'findMany', {}, owner);
    ok('Store', 'findMany', {}, owner);
    ok('Product', 'create', { data: { storeId: B } }, owner);
    expect(() =>
      assertRawScoped('$queryRaw', { strings: ['SELECT * FROM orders'], values: [] }, owner)
    ).not.toThrow();
  });
});

describe('raw SQL (R-EBDA-004)', () => {
  const tpl = (sql: string) => ({ strings: [sql], values: [] });

  it('reads the SQL text of every raw form', () => {
    expect(rawSqlText(['SELECT 1 FROM orders WHERE id = $1', 'x'])).toBe(
      'SELECT 1 FROM orders WHERE id = $1'
    );
    expect(
      rawSqlText({ strings: ['SELECT * FROM stores WHERE id = ', ''], values: ['x'] })
    ).toMatch(/FROM stores/);
    expect(rawSqlText({ sql: 'SELECT 2', values: [] })).toBe('SELECT 2');
  });

  it('finds guarded tables in FROM / JOIN / INTO / UPDATE / USING, quoted or schema-qualified', () => {
    expect(guardedTablesIn('SELECT * FROM public."orders" o JOIN order_items i ON true')).toEqual([
      'orders',
      'order_items',
    ]);
    expect(guardedTablesIn('INSERT INTO products (id) VALUES ($1)')).toEqual(['products']);
    expect(guardedTablesIn('UPDATE "SlugRedirect" SET x = 1')).toEqual(['slugredirect']);
    expect(guardedTablesIn('DELETE FROM carts USING cart_items')).toEqual(['carts', 'cart_items']);
    expect(guardedTablesIn('SELECT * FROM stores')).toEqual(['stores']);
    expect(guardedTablesIn('SELECT * FROM public.ebda_resolve_store_id($1, $2)')).toEqual([]);
    expect(guardedTablesIn('SELECT relname FROM pg_class')).toEqual([]);
    expect(guardedTablesIn('SELECT * FROM plans')).toEqual([]);
  });

  it('contextless: refused when it names a tenant table, allowed for definers / catalog / set_config', () => {
    expect(() => assertRawScoped('$queryRaw', tpl('SELECT * FROM orders'), none)).toThrow(
      TenantScopeViolation
    );
    expect(() =>
      assertRawScoped('$executeRawUnsafe', ['DELETE FROM products WHERE id = $1', 'x'], none)
    ).toThrow(/products/);
    expect(() =>
      assertRawScoped('$queryRaw', tpl('SELECT * FROM public.ebda_resolve_store_id($1,$2)'), none)
    ).not.toThrow();
    expect(() =>
      assertRawScoped(
        '$queryRawUnsafe',
        ["SELECT set_config('app.current_store_id', $1, true)", A],
        none
      )
    ).not.toThrow();
    expect(() => assertRawScoped('$queryRaw', tpl('SELECT 1'), none)).not.toThrow();
  });

  it('with an ambient store or user, RLS is the layer and the statement is allowed', () => {
    expect(() => assertRawScoped('$queryRaw', tpl('SELECT * FROM orders'), inA)).not.toThrow();
    expect(() =>
      assertRawScoped('$queryRaw', tpl('SELECT * FROM users'), { userId: U })
    ).not.toThrow();
  });

  it('unreadable SQL with no context fails closed', () => {
    expect(() => assertRawScoped('$queryRaw', { weird: true }, none)).toThrow(/unreadable/);
  });
});
