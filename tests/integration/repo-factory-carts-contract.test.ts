/**
 * INFRA-CF-1 PR R2 (Ruling CF-R2-1): the shopper's cart (carts, cart_items, cart_bundles) moved to the StoreDO gives the same
 * answer and leaves the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real `CartService` /
 * `OrderService`; it runs once on Postgres (the unchanged code) and once with the DO read and write clients over the real DO
 * schema on SQLite (the real wire codec and prisma-lite). Each backend gets its own identical world; the scrubbed traces
 * (return values or error status + code, then the cart rows) must be equal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { CartService } from '../../apps/api/src/services/cart.service';
import { OrderService } from '../../apps/api/src/services/order.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  makeMoneyClient,
  storeDb,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';

const sfx = Date.now().toString(36);
let STORE = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/ORD-[A-Z0-9-]+/g, '<no>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

interface World {
  plain: string;
  tight: string; // 2 in stock, tracked
  noted: string; // takes a personalisation note
  sized: string; // variant product
  small: string;
  large: string;
  gone: string; // draft: not purchasable
  bundle: string;
  names: Record<string, string>;
}
let n = 0;
async function world(mirror: boolean): Promise<World> {
  const k = `${sfx}${++n}`;
  const mk = (name: string, over: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        storeId: STORE,
        name,
        slug: `${name}-${k}`,
        price: 10_000,
        status: 'active',
        inventory: 50,
        trackInventory: true,
        ...over,
      },
    });
  const plain = await mk('plain');
  const tight = await mk('tight', { inventory: 2 });
  const noted = await mk('noted', {
    personalisation: { enabled: true, required: false, maxLength: 20, label: 'Name' },
  });
  const sized = await mk('sized', { inventory: 0 });
  const gone = await mk('gone', { status: 'draft' });
  const variant = (title: string, inventory: number) =>
    prisma.productVariant.create({
      data: { productId: sized.id, title, price: 12_000, inventory, isActive: true },
    });
  const small = await variant('S', 3);
  const large = await variant('L', 3);
  const bundle = await prisma.bundle.create({
    data: {
      storeId: STORE,
      name: `box-${k}`,
      slug: `box-${k}`,
      pricingType: 'fixed_price',
      pricingValue: 15_000,
      isActive: true,
      items: {
        create: [
          { productId: plain.id, quantity: 1 },
          { productId: tight.id, quantity: 1 },
        ],
      },
    },
    include: { items: true },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Product', [plain, tight, noted, sized, gone] as never);
    insertSqlite(sqlite, 'ProductVariant', [small, large] as never);
    const { items, ...b } = bundle;
    insertSqlite(sqlite, 'Bundle', [b] as never);
    insertSqlite(sqlite, 'BundleItem', items as never);
  }
  return {
    plain: plain.id,
    tight: tight.id,
    noted: noted.id,
    sized: sized.id,
    small: small.id,
    large: large.id,
    gone: gone.id,
    bundle: bundle.id,
    names: {
      [plain.id]: 'plain',
      [tight.id]: 'tight',
      [noted.id]: 'noted',
      [sized.id]: 'sized',
      [small.id]: 'small',
      [large.id]: 'large',
      [gone.id]: 'gone',
      [bundle.id]: 'bundle',
    },
  };
}

/** ids -> names of the world being run, so rows can be ORDERED by name before the ids are scrubbed */
let NAMES: Record<string, string> = {};
const nm = (id: unknown) => (typeof id === 'string' ? (NAMES[id] ?? id) : id);
/** What a shopper's cart looks like, backend-neutral. */
const view = (c: any) => ({
  items: (c?.items ?? [])
    .map((i: any) => ({
      product: nm(i.productId),
      variant: nm(i.variantId),
      qty: i.quantity,
      note: i.note ?? null,
      unit: i.unitPrice,
      total: i.lineTotal,
      unavailable: i.unavailable ?? false,
    }))
    .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))), // row order is not part of the contract
  bundles: (c?.bundles ?? []).map((b: any) => ({ bundle: nm(b.bundleId), qty: b.quantity })),
  subtotal: c?.subtotal,
});
async function rows() {
  const db = (await storeDb(STORE)) as any;
  const carts = await db.cart.findMany({
    where: { storeId: STORE },
    select: { id: true, sessionId: true, customerId: true },
  });
  const ids = carts.map((c: any) => c.id);
  const items = await db.cartItem.findMany({
    where: { cartId: { in: ids } },
    select: { productId: true, variantId: true, quantity: true, note: true },
  });
  const bundles = await db.cartBundle.findMany({
    where: { cartId: { in: ids } },
    select: { bundleId: true, quantity: true },
  });
  const key = (r: unknown) => JSON.stringify(r);
  return {
    carts: carts
      .map((c: any) => ({ session: c.sessionId, customer: c.customerId }))
      .sort((a: any, b: any) => key(a).localeCompare(key(b))),
    items: items
      .map((i: any) => ({ ...i, productId: nm(i.productId), variantId: nm(i.variantId) }))
      .sort((a: any, b: any) => key(a).localeCompare(key(b))),
    bundles: bundles
      .map((b: any) => ({ ...b, bundleId: nm(b.bundleId) }))
      .sort((a: any, b: any) => key(a).localeCompare(key(b))),
  };
}

async function parity(scenario: (w: World, session: string) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror);
    NAMES = w.names;
    const session = cartSessionId('r2cart');
    // each backend gets its own store-wide clean slate of carts so the row listing is that scenario's alone
    await prisma.cart.deleteMany({ where: { storeId: STORE } });
    sqlite.exec('DELETE FROM carts');
    const out = await settle(() => on(() => scenario(w, session)));
    return scrub({ out, state: await on(rows) }, { ...w.names, [session]: 'session' });
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `r2cart-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'R',
      lastName: 'C',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  STORE = (
    await prisma.store.create({
      data: { name: 'R2cart', slug: `r2cart-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'R2cart', ?, ?)`
    )
    .run(STORE, `r2cart-${sfx}`, owner.id);
  await prisma.paymentConfig.create({
    data: {
      storeId: STORE,
      provider: 'cod',
      isEnabled: true,
      fixedFee: 0,
      settings: { percentBps: 0 },
    },
  });
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

const address = {
  firstName: 'Mona',
  lastName: 'Adel',
  address1: 'Nasr City',
  city: 'Cairo',
  state: 'Cairo',
  postalCode: '',
  country: 'Egypt',
  phone: '+201031234567',
};

describe.skipIf(!hasDb)('cart (CartService) on Postgres vs the DO', () => {
  it('addItem: creates the cart, merges the same line by increment, and a different note or variant is its own line', async () => {
    const t = await parity(async (w, s) => {
      await CartService.addItem(STORE, s, w.plain, 1);
      await CartService.addItem(STORE, s, w.plain, 2);
      await CartService.addItem(STORE, s, w.noted, 1, undefined, undefined, 'Sara');
      await CartService.addItem(STORE, s, w.noted, 1, undefined, undefined, 'Omar');
      await CartService.addItem(STORE, s, w.noted, 1, undefined, undefined, 'Sara');
      await CartService.addItem(STORE, s, w.sized, 1, undefined, w.small);
      return view(await CartService.addItem(STORE, s, w.sized, 2, undefined, w.large));
    });
    expect(t.state.items).toHaveLength(5);
    expect(t.state.carts).toHaveLength(1);
  });

  it('addItem refusals: stock, a draft product, a variant product without a variant, a foreign variant', async () => {
    const t = await parity(async (w, s) => {
      const tries = [
        () => CartService.addItem(STORE, s, w.tight, 3),
        () => CartService.addItem(STORE, s, w.gone, 1),
        () => CartService.addItem(STORE, s, w.sized, 1),
        () => CartService.addItem(STORE, s, w.plain, 1, undefined, w.small),
        () => CartService.addItem(STORE, s, w.sized, 9, undefined, w.small),
      ];
      const out = [];
      for (const f of tries) out.push(await settle(f));
      await CartService.addItem(STORE, s, w.tight, 2);
      out.push(await settle(() => CartService.addItem(STORE, s, w.tight, 1))); // 2 + 1 > 2
      return out;
    });
    expect(t.state.items).toEqual([
      { productId: 'tight', variantId: null, quantity: 2, note: null },
    ]);
  });

  it('addItems (the guest-to-login sync): sums the payload, merges existing lines, skips invalid lines, and refuses the whole payload on stock', async () => {
    const t = await parity(async (w, s) => {
      await CartService.addItem(STORE, s, w.plain, 1);
      const synced = await CartService.addItems(STORE, s, [
        { productId: w.plain, quantity: 2 },
        { productId: w.plain, quantity: 1 },
        { productId: w.sized, quantity: 1, variantId: w.small },
        { productId: w.sized, quantity: 1 }, // variant required: skipped
        { productId: w.gone, quantity: 1 }, // not purchasable: skipped
        { productId: w.noted, quantity: 1, note: 'Sara' },
      ]);
      const refused = await settle(() =>
        CartService.addItems(STORE, s, [
          { productId: w.plain, quantity: 1 },
          { productId: w.tight, quantity: 5 },
        ])
      );
      return { synced: view(synced), refused };
    });
    expect(t.out.ok.refused.err.code).toBe('INSUFFICIENT_INVENTORY');
    // the refused payload left the cart as it was (the plain line was NOT incremented)
    expect(t.state.items.find((i: any) => i.productId === 'plain').quantity).toBe(4);
  });

  it('updateItem / removeItem / clear: quantity, delete at zero, stock, a foreign line is 404', async () => {
    const t = await parity(async (w, s) => {
      const c = await CartService.addItem(STORE, s, w.plain, 1);
      const a = await CartService.addItem(STORE, s, w.tight, 1);
      const plainId = c.items[0].id;
      const tightId = a.items.find((i: any) => i.productId === w.tight)!.id;
      const out: unknown[] = [];
      out.push(view(await CartService.updateItem(STORE, s, plainId, 5)));
      out.push(await settle(() => CartService.updateItem(STORE, s, tightId, 9)));
      out.push(await settle(() => CartService.updateItem(STORE, s, 'nope-' + plainId.slice(5), 1)));
      out.push(view(await CartService.updateItem(STORE, s, tightId, 0)));
      out.push(await settle(() => CartService.removeItem(STORE, s, tightId)));
      out.push(view(await CartService.removeItem(STORE, s, plainId)));
      await CartService.addItem(STORE, s, w.plain, 1);
      out.push(view(await CartService.clear(STORE, s)));
      return out;
    });
    expect(t.state.items).toEqual([]);
    expect(t.state.carts).toHaveLength(1);
  });

  it('bundles: add merges by increment, stock caps it, remove deletes the line', async () => {
    const t = await parity(async (w, s) => {
      const first = await CartService.addBundle(STORE, s, w.bundle, 1);
      await CartService.addBundle(STORE, s, w.bundle, 1);
      const over = await CartService.addBundle(STORE, s, w.bundle, 5); // the tight component has 2
      const line = (await CartService.view(STORE, s)).bundles[0];
      const removed = await CartService.removeBundle(STORE, s, line.id);
      return { first: first.ok, over, removed: view(removed) };
    });
    expect(t.out.ok.over).toEqual({ ok: false, error: 'insufficient_stock' });
    expect(t.state.bundles).toEqual([]);
  });

  it('mergeGuestCart: a guest cart is promoted when the shopper has none, merged by increment when they do', async () => {
    const t = await parity(async (w, s) => {
      const customer = (
        await prisma.user.create({
          data: {
            email: `c-${Math.random().toString(36).slice(2)}@example.test`,
            passwordHash: 'x'.repeat(60),
            firstName: 'C',
            lastName: 'U',
            role: 'customer',
            storeId: STORE,
            status: 'active',
          },
        })
      ).id;
      if (onDoNow()) sqliteCustomer(customer);
      await CartService.addItem(STORE, s, w.plain, 2);
      await CartService.addItem(STORE, s, w.noted, 1, undefined, undefined, 'Sara');
      await CartService.addBundle(STORE, s, w.bundle, 1);
      const promoted = await CartService.mergeGuestCart(STORE, s, customer);
      // a second guest cart merges into the customer's cart
      const s2 = s + '-2';
      await CartService.addItem(STORE, s2, w.plain, 3);
      await CartService.addItem(STORE, s2, w.sized, 1, undefined, w.small);
      await CartService.addBundle(STORE, s2, w.bundle, 1);
      const merged = await CartService.mergeGuestCart(STORE, s2, customer);
      return { promoted: view(promoted), merged: view(merged) };
    });
    expect(t.state.carts).toHaveLength(1);
    expect(t.state.items.find((i: any) => i.productId === 'plain').quantity).toBe(5);
  });

  it('checkout consumes the cart on the DO and a keyed retry returns the same order, not EMPTY_CART', async () => {
    const t = await parity(async (w, s) => {
      await CartService.addItem(STORE, s, w.plain, 2);
      const data = { shippingAddress: address, paymentMethod: 'cod' } as never;
      const ctx = { idempotencyKey: 'retry-me-12345' } as never;
      const first = await OrderService.create(STORE, undefined, s, data, undefined, ctx);
      const retry = await OrderService.create(STORE, undefined, s, data, undefined, ctx);
      const again = await settle(() => OrderService.create(STORE, undefined, s, data, undefined));
      return { same: retry?.id === first?.id, total: first?.total, again };
    });
    expect(t.out.ok.same).toBe(true);
    expect(t.out.ok.again.err.code).toBe('EMPTY_CART');
    expect(t.state.items).toEqual([]);
  });

  it('rollbackForPaymentFailure: the order is cancelled, stock comes back, and the cart is rebuilt from the order lines (box and personalised line kept)', async () => {
    const t = await parity(async (w, s) => {
      await CartService.addItem(STORE, s, w.plain, 2);
      await CartService.addItem(STORE, s, w.noted, 1, undefined, undefined, 'Sara');
      await CartService.addBundle(STORE, s, w.bundle, 1);
      const o = await OrderService.create(
        STORE,
        undefined,
        s,
        { shippingAddress: address, paymentMethod: 'cod' } as never,
        undefined
      );
      await OrderService.rollbackForPaymentFailure(STORE, o!.id, s);
      await OrderService.rollbackForPaymentFailure(STORE, o!.id, s); // idempotent
      const db = (await storeDb(STORE)) as any;
      const after = await db.order.findFirst({
        where: { id: o!.id },
        select: { status: true, notes: true },
      });
      return { after };
    });
    expect(t.out.ok.after.status).toBe('cancelled');
    expect(t.state.items.map((i: any) => i.note)).toContain('Sara');
    expect(t.state.bundles).toEqual([{ bundleId: 'bundle', quantity: 1 }]);
  });
});

// the mirror of a customer user into the DO world (the DO keeps its own customers table)
let currentBackend: 'pg' | 'do' = 'pg';
const onDoNow = () => currentBackend === 'do';
function sqliteCustomer(_id: string) {
  /* the cart's customer id is an external reference on the DO; no row is needed */
}
