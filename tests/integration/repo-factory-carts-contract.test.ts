/**
 * INFRA-CF-1 PR R2 (Ruling CF-R2-1): the shopper's cart (carts, cart_items, cart_bundles) moved to the StoreDO gives the same
 * answer and leaves the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real `CartService` /
 * `OrderService`; it runs once on Postgres (the unchanged code) and once with the DO read and write clients over the real DO
 * schema on SQLite (the real wire codec and prisma-lite). Each backend gets its own identical world; the scrubbed traces
 * (return values or error status + code, then the cart rows) must be equal.
 */
import crypto from 'node:crypto';
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
  storeMoney,
  storeWriter,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { GoldRateService } from '../../apps/api/src/services/gold-rate/gold-rate.service';
import { createProduct, ownerPool } from '../helpers/gold-sql';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';
import { withPgStoreDelegate } from '../helpers/do-store-delegate';

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
    db: withPgStoreDelegate(c) as StoreReads,
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
  // PR R4 (Ruling CF-R4-3): the price the cart shows (tiers, group price, MOQ flag, gold facts) is loaded from the store's own
  // backend. The pure maths is shared; what is compared here is the LOADING: tiers, the buyer's group and the gold rows.
  it('cart pricing: list price, tier, group price, MOQ flag and gold facts are the same for anonymous, group and plain buyers', async () => {
    const ownerPg = ownerPool();
    const t = await parity(async (w, s) => {
      vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(true); // b2b.wholesale on
      const onDoRun = !!(await storeMoney(STORE));
      const mirror = (model: string, rows: unknown[]) => {
        if (onDoRun) insertSqlite(sqlite, model, rows as never);
      };
      await prisma.product.update({ where: { id: w.plain }, data: { moq: 3 } });
      if (onDoRun) sqlite.prepare('UPDATE products SET moq = 3 WHERE id = ?').run(w.plain);
      const tier = await prisma.productPriceTier.create({
        data: { storeId: STORE, productId: w.plain, minQty: 5, priceMinor: 8_000 },
      });
      mirror('ProductPriceTier', [tier]);
      const group = await prisma.customerGroup.create({
        data: {
          storeId: STORE,
          name: `Wholesale ${Math.random().toString(36).slice(2, 7)}`,
          isWholesale: true,
          pricingMode: 'percent_off',
          discountBps: 1_000,
          isActive: true,
        },
      });
      mirror('CustomerGroup', [group]);
      const user = await prisma.user.create({
        data: {
          email: `r4p-${Math.random().toString(36).slice(2)}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Whole',
          lastName: 'Saler',
          role: 'customer',
          storeId: STORE,
          status: 'active',
        },
      });
      const customer = await prisma.customer.create({
        data: {
          storeId: STORE,
          userId: user.id,
          groupId: group.id,
          firstName: 'Whole',
          lastName: 'Saler',
          email: user.email,
        },
      });
      mirror('Customer', [customer]);
      // a gold-rate product with a current rate: the cart carries its public pricing facts
      const goldId = await createProduct(ownerPg, STORE, {
        mode: 'gold_rate',
        karat: 21,
        weightMg: 3250,
        makingType: 'per_gram',
        makingValue: 15_000,
        price: 1,
        slug: `gold-${sfx}-${++n}`,
      });
      // the world is built on Postgres and then mirrored: the rate write itself must stay on Postgres here
      await onPg(async () =>
        GoldRateService.applyRates(
          STORE,
          { rates: [{ karat: 21, ratePerGram: 576_000 }], confirm: true },
          { userId: (await prisma.store.findUniqueOrThrow({ where: { id: STORE } })).ownerId }
        )
      );
      const gold = await prisma.product.findUniqueOrThrow({ where: { id: goldId } });
      mirror('Product', [gold]);
      mirror('GoldRate', await prisma.goldRate.findMany({ where: { storeId: STORE } }));
      mirror(
        'GoldRateCurrent',
        await prisma.goldRateCurrent.findMany({ where: { storeId: STORE } })
      );
      w.names[goldId] = 'gold';
      w.names[group.id] = 'group';
      w.names[customer.id] = 'customer';
      w.names[user.id] = 'user';
      for (const [id, q] of [
        [w.plain, 1],
        [w.plain, 2],
        [goldId, 1],
        [w.sized, 1],
      ] as const)
        await CartService.addItem(STORE, s, id, q, undefined, id === w.sized ? w.small : undefined);
      const price = (c: any) => ({
        items: c.items
          .map((i: any) => ({
            product: w.names[i.productId],
            qty: i.quantity,
            unit: i.unitPrice,
            total: i.lineTotal,
            list: i.listPrice,
            source: i.priceSource,
            tier: i.priceTierMinQty,
            ladderTop: i.priceLadderTopMinQty,
            belowMoq: i.belowMoq,
            moq: i.moqRequired,
            gold: i.goldPricing && {
              karat: i.goldPricing.karat,
              rate: i.goldPricing.ratePerGram,
              weight: i.goldPricing.weightMg,
            },
          }))
          .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        subtotal: c.subtotal,
      });
      const retail = price(await CartService.view(STORE, s));
      const asGroup = price(
        await CartService.view(STORE, s, undefined, { kind: 'session', userId: user.id } as never)
      );
      // five of the plain line reach the tier break; the group price stacks per the resolver's rules
      await CartService.addItem(STORE, s, w.plain, 3);
      const tiered = price(await CartService.view(STORE, s));
      const tieredGroup = price(
        await CartService.view(STORE, s, undefined, { kind: 'session', userId: user.id } as never)
      );
      // the entitlement off: tiers and group prices are dropped, MOQ stays
      vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
      const noPlan = price(
        await CartService.view(STORE, s, undefined, { kind: 'session', userId: user.id } as never)
      );
      return { retail, asGroup, tiered, tieredGroup, noPlan };
    });
    await ownerPg.end();
    const o = t.out.ok;
    expect(JSON.stringify(o.retail)).toContain('"belowMoq"');
    expect(o.tiered.items.find((i: any) => i.product === 'plain').source).not.toBe('base');
    expect(o.tieredGroup.subtotal).toBeLessThan(o.tiered.subtotal);
    expect(o.noPlan.items.find((i: any) => i.product === 'plain').source).toBe('base');
    expect(o.retail.items.find((i: any) => i.product === 'gold').gold.karat).toBe(21);
  });

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

// ---------------------------------------------------------------------------------------------------------------------
// PR R4 (Ruling CF-R4-4): the newsletter list and its consent; (Ruling CF-R4-5): the abandoned-cart jobs
// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!hasDb)('newsletter consent and abandoned-cart jobs on Postgres vs the DO', () => {
  const mini = async () => {
    const [{ default: express }, { default: publicRoutes }, { default: campaignPublic }] =
      await Promise.all([
        import('express'),
        import('../../apps/api/src/routes/public.routes'),
        import('../../apps/api/src/routes/campaign-public.routes'),
      ]);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/public/campaigns', campaignPublic);
    app.use('/api/v1/public', publicRoutes);
    return app;
  };
  const row = async (email: string) => {
    const db = (await storeDb(STORE)) as any;
    return db.newsletterSubscriber.findMany({
      where: { storeId: STORE, email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        isActive: true,
        language: true,
        source: true,
        consentScope: true,
        consentAt: true,
        unsubscribedAt: true,
      },
    });
  };
  it('signup, re-signup, one-click unsubscribe, re-subscribe, the cart opt-in box and the campaign audience keep the same consent rules', async () => {
    process.env.CAMPAIGN_UNSUBSCRIBE_SECRET ||= 'contract-unsub-secret';
    const request = (await import('supertest')).default;
    const { signSubscriberUnsubscribeToken } =
      await import('../../apps/api/src/lib/campaign-unsubscribe-token');
    const { recordCartEmailConsent } =
      await import('../../apps/api/src/services/cart-email-optin.service');
    const { buildCampaignAudience, audienceCount } =
      await import('../../apps/api/src/services/campaign.service');
    const t = await parity(async (w, s) => {
      const app = await mini();
      const signup = (email: string, extra: Record<string, unknown> = {}) =>
        request(app)
          .post('/api/v1/public/newsletter/subscribe')
          .set('X-Store-ID', STORE)
          // the limiter keys on the session id: a fresh one per call keeps the contract off the rate limit
          .set('X-Session-Id', crypto.randomUUID())
          .send({ email, language: 'ar', source: 'footer', ...extra });
      const brief = (r: { status: number; body: any }) => ({
        status: r.status,
        already: r.body?.data?.alreadySubscribed,
        code: r.body?.error?.code,
      });
      const out: Record<string, unknown> = {};
      out.signup = brief(await signup('Reader.One@Example.TEST'));
      out.again = brief(await signup('reader.one@example.test'));
      out.badEmail = brief(await signup('not-an-email'));
      const [sub] = await row('reader.one@example.test');
      out.afterSignup = { ...sub, id: undefined, consentAt: sub.consentAt !== null };
      const token = signSubscriberUnsubscribeToken(STORE, sub.id);
      const info = await request(app).get('/api/v1/public/campaigns/unsubscribe').query({ token });
      out.info = {
        status: info.status,
        email: info.body?.data?.email,
        already: info.body?.data?.alreadyUnsubscribed,
      };
      const unsub = await request(app).post('/api/v1/public/campaigns/unsubscribe').send({ token });
      out.unsub = { status: unsub.status, done: unsub.body?.data?.unsubscribed };
      const unsubAgain = await request(app)
        .post('/api/v1/public/campaigns/unsubscribe')
        .send({ token });
      out.unsubAgain = { status: unsubAgain.status, done: unsubAgain.body?.data?.unsubscribed };
      const info2 = await request(app).get('/api/v1/public/campaigns/unsubscribe').query({ token });
      out.info2 = info2.body?.data?.alreadyUnsubscribed;
      const forged = await request(app)
        .post('/api/v1/public/campaigns/unsubscribe')
        .send({ token: token.slice(0, -3) + 'abc' });
      out.forged = forged.status;
      out.afterUnsub = (await row('reader.one@example.test')).map((r: any) => ({
        active: r.isActive,
        unsub: r.unsubscribedAt !== null,
      }));
      out.resubscribe = brief(
        await signup('reader.one@example.test', { source: 'popup', language: 'en' })
      );
      out.afterResub = (await row('reader.one@example.test')).map((r: any) => ({
        active: r.isActive,
        unsub: r.unsubscribedAt !== null,
        source: r.source,
        language: r.language,
      }));
      out.noToken = (
        await request(app).post('/api/v1/public/campaigns/unsubscribe').send({})
      ).status;

      // the checkout box: narrow consent, never re-activates a "no", withdrawal touches only the cart
      await CartService.addItem(STORE, s, w.plain, 1);
      out.optIn = await recordCartEmailConsent(STORE, s, {
        email: 'Guest.Cart@Example.test',
        consent: true,
        language: 'ar',
      });
      out.optInAgain = await recordCartEmailConsent(STORE, s, {
        email: 'guest.cart@example.test',
        consent: true,
      });
      out.optInBad = await recordCartEmailConsent(STORE, s, { email: 'nope', consent: true });
      await (
        await storeWriter(STORE)
      ).newsletterSubscriber.create({
        data: {
          storeId: STORE,
          email: 'said.no@example.test',
          isActive: false,
          unsubscribedAt: new Date(),
        },
      });
      // a deliberate "no" is never undone by a stranger's checkbox
      out.optInOnUnsub = await recordCartEmailConsent(STORE, s, {
        email: 'Said.No@example.test',
        consent: true,
      });
      out.optInNoCart = await recordCartEmailConsent(STORE, 'no-such-session', {
        email: 'x@example.test',
        consent: true,
      });
      out.cartRow = (await row('guest.cart@example.test')).map((r: any) => ({
        scope: r.consentScope,
        source: r.source,
        active: r.isActive,
        consent: r.consentAt !== null,
      }));
      out.withdraw = await recordCartEmailConsent(STORE, s, {
        email: 'guest.cart@example.test',
        consent: false,
      });

      // the audience: active + not cart_reminders, deduped by normalised address; the count agrees with the list
      await signup('dup@example.test');
      const w2 = await storeWriter(STORE);
      await w2.newsletterSubscriber.create({
        data: {
          storeId: STORE,
          email: 'DUP@example.test',
          isActive: true,
          consentScope: 'newsletter',
        },
      });
      await w2.newsletterSubscriber.create({
        data: {
          storeId: STORE,
          email: 'gone@example.test',
          isActive: false,
          consentScope: 'newsletter',
        },
      });
      await w2.newsletterSubscriber.create({
        data: {
          storeId: STORE,
          email: 'broken-address',
          isActive: true,
          consentScope: 'newsletter',
        },
      });
      const audience = await buildCampaignAudience(STORE);
      out.audience = audience.map(a => `${a.email}|${a.language}`).sort();
      out.audienceCount = await audienceCount(STORE);
      return out;
    });
    const o = t.out.ok;
    expect(o.signup).toEqual({ status: 200, already: false });
    expect(o.again).toEqual({ status: 200, already: true });
    expect(o.unsub.done).toBe(true);
    expect(o.afterUnsub).toEqual([{ active: false, unsub: true }]);
    expect(o.optInOnUnsub.status).toBe('unsubscribed');
    expect(o.cartRow).toEqual([
      { scope: 'cart_reminders', source: 'checkout', active: true, consent: true },
    ]);
    expect(o.audience.some((a: string) => a.startsWith('guest.cart'))).toBe(false);
    expect(o.audience.some((a: string) => a.startsWith('gone@'))).toBe(false);
    expect(o.audienceCount).toBe(o.audience.length);
  });

  // The 15-minute sweep: detection (a customer with a contact, a consented guest, none reachable), the reminder steps, the
  // recovery coupon and the recovery e-mail's claim, over the store's own rows.
  it('abandoned-cart detection, reminders, recovery coupon and the e-mail claim: same rows and same dispatches', async () => {
    const { abandonedCartService } =
      await import('../../apps/api/src/services/abandoned-cart.service');
    const { sweepCartRecoveryEmails } =
      await import('../../apps/api/src/services/cart-recovery-email.service');
    const { inngest } = await import('../../apps/api/src/lib/inngest/client');
    const { notificationDispatcher } =
      await import('../../apps/api/src/services/notification-dispatcher.service');
    const sent = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    const dispatched: string[] = [];
    vi.spyOn(notificationDispatcher, 'dispatch').mockImplementation(async (_s, ev, data) => {
      dispatched.push(
        `${ev}|${(data as any).customerName}|${(data as any).cartItemCount}|${!!(data as any).couponCode}`
      );
    });
    // the sweep runs for every store with the feature: only this one is under test
    vi.spyOn(featureService, 'isFeatureEnabled').mockImplementation(
      async (id: string) => id === STORE
    );
    const dir = await import('@ebda/database');
    vi.spyOn(dir, 'storeDirectory').mockImplementation((async () => [{ id: STORE }]) as never);
    const t = await parity(async (w, s) => {
      dispatched.length = 0;
      const user = await prisma.user.create({
        data: {
          email: `ab-${Math.random().toString(36).slice(2)}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'Nour',
          lastName: 'Aly',
          phone: '+201055550000',
          role: 'customer',
          storeId: STORE,
          status: 'active',
        },
      });
      w.names[user.id] = 'user';
      const onDoRun = !!(await storeMoney(STORE));
      const cfg = (await storeWriter(STORE)).abandonedCartConfig;
      await cfg.upsert({
        where: { storeId: STORE },
        create: { storeId: STORE, emailEnabled: true, emailDelayMinutes: 60 },
        update: { emailEnabled: true, emailDelayMinutes: 60 },
      });
      // three carts: a customer's, a consented guest's, a guest nobody can reach
      const w3 = await storeWriter(STORE);
      const idle = new Date(Date.now() - 3 * 3_600_000);
      const mk = async (sessionId: string, data: Record<string, unknown>) => {
        const c = await CartService.getOrCreate(
          STORE,
          sessionId,
          data.customerId as string | undefined
        );
        await CartService.addItem(STORE, sessionId, w.plain, 2);
        await w3.cart.update({ where: { id: c.id }, data: { ...data, lastActivityAt: idle } });
        return c.id;
      };
      await mk(s + '-cust', { customerId: user.id });
      await mk(s + '-guest', {
        guestEmail: 'guest.recovery@example.test',
        guestEmailConsentAt: idle,
      });
      await mk(s + '-nobody', {});
      // the guest's consent row (the checkout box wrote it on the real path)
      await w3.newsletterSubscriber.create({
        data: {
          storeId: STORE,
          email: 'guest.recovery@example.test',
          consentScope: 'cart_reminders',
          isActive: true,
        },
      });
      const db = (await storeDb(STORE)) as any;
      const abandoned = async () =>
        (
          await db.abandonedCart.findMany({
            where: { storeId: STORE },
            orderBy: { createdAt: 'asc' },
          })
        )
          .map((a: any) => ({
            customer: a.customerId ? 'user' : null,
            email:
              a.customerEmail === 'guest.recovery@example.test'
                ? 'guest'
                : a.customerEmail
                  ? '<email>'
                  : null,
            total: a.cartTotal,
            count: a.cartItemCount,
            status: a.status,
            emailStatus: a.emailStatus,
            hasCoupon: a.couponId !== null,
            step1: a.step1SentAt !== null,
            step3: a.step3SentAt !== null,
            next: a.nextStepAt !== null,
          }))
          .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      await abandonedCartService.detectNewAbandonments();
      const afterDetect = await abandoned();
      // make every step due, run the reminders three times (steps 1, 2, 3 with the recovery coupon)
      for (let i = 0; i < 3; i++) {
        await w3.abandonedCart.updateMany({
          where: { storeId: STORE, nextStepAt: { not: null } },
          data: { nextStepAt: new Date(Date.now() - 1000) },
        });
        await abandonedCartService.processReminders();
      }
      const afterReminders = await abandoned();
      // the e-mail channel: due now, claimed once (NULL -> queued), the event emitted once per cart
      await w3.abandonedCart.updateMany({ where: { storeId: STORE }, data: { emailStatus: null } });
      sent.mockClear();
      const swept = await sweepCartRecoveryEmails(new Date(Date.now() + 5 * 60_000));
      const sweptAgain = await sweepCartRecoveryEmails(new Date(Date.now() + 5 * 60_000));
      const coupons = await db.coupon.findMany({
        where: { storeId: STORE, code: { startsWith: 'RECOVER-' } },
        select: {
          type: true,
          value: true,
          usageLimit: true,
          isActive: true,
          usageLimitPerUser: true,
        },
      });
      void onDoRun;
      return {
        afterDetect,
        afterReminders,
        dispatched: [...dispatched].sort(),
        swept,
        sweptAgain,
        events: sent.mock.calls.length,
        coupons,
      };
    });
    const o = t.out.ok;
    expect(o.afterDetect).toHaveLength(2); // the unreachable guest cart is not recorded
    expect(o.afterDetect.some((a: any) => a.customer === 'user' && a.next)).toBe(true);
    expect(o.coupons).toHaveLength(1);
    expect(o.dispatched.length).toBe(3);
    expect(o.swept.claimed).toBeGreaterThan(0);
    expect(o.sweptAgain.claimed).toBe(0);
  });
});

// the mirror of a customer user into the DO world (the DO keeps its own customers table)
let currentBackend: 'pg' | 'do' = 'pg';
const onDoNow = () => currentBackend === 'do';
function sqliteCustomer(_id: string) {
  /* the cart's customer id is an external reference on the DO; no row is needed */
}
