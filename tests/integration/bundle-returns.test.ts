/**
 * Atomic bundle returns (Task 7, product bundles) — the money path second
 * only to Task 6 in risk.
 *
 * Task 6 made checkout expand a bundle box into ordinary `OrderItem`
 * component lines sharing a `bundleGroupId`, one group per box, with the
 * bundle price allocated across them (`Σ(line.total) === bundlePrice` per
 * group, `line.price × line.quantity === line.total` on every line). This
 * file proves RETURNS treat a bundle group as an atomic unit, per the
 * design doc's "Returns — atomic" ruling:
 *
 *   - a bundle group is selectable as ONE unit (`ReturnService.create`'s new
 *     `bundleGroupIds` field); the refund is Σ of the group's line totals,
 *     which by Task 6's invariant is exactly the bundle price;
 *   - restocking returns EVERY component's quantity;
 *   - naming an individual component line's `orderItemId` in the ordinary
 *     `items` array is refused with `bundle_returns_are_atomic` (422);
 *   - a bundle-group return goes through the SAME status/restock/refund
 *     machinery as any other return — no parallel refund mechanism.
 *
 * Real Postgres throughout (mirrors
 * tests/integration/order-bundles.test.ts and
 * tests/integration/partial-return-refund-effects.test.ts):
 * `ReturnService.create`/`.complete` and `handleOrderRefunded` are called
 * directly, bypassing HTTP, for the business-logic suite below. A SEPARATE
 * describe block at the bottom of this file exercises the route layer
 * (`return.routes.ts`'s Zod schema + `authenticate` gate) over real HTTP —
 * fix-round-1 Finding 1 named exactly this gap: the route's schema didn't
 * know `bundleGroupIds` existed, so a real request would 400 on Zod before
 * ever reaching the service this file's business-logic tests exercise.
 * Gated on `hasDb` so both suites skip cleanly when no real database is
 * configured.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { prisma } from '@ebda/database';
import { ReturnService } from '@api/services/return.service';
import { OrderService } from '@api/services/order.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedBundle,
  seedCustomer,
  stockOf,
  checkoutBundleFor,
  groupOf,
  groupsOf,
  createBundleReturn,
  markOrderDelivered,
  buildReturnTestApp,
  returnsClientFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

/** Same "Ramadan Box" worked example as order-bundles.test.ts: Dates ×1 (4.500 EGP), Honey ×1 (6.000), Nuts ×2 (2.000 each) — componentSum 14.500, fixed_price 12.000 (a real 2.500 discount, so shelf-price and allocated-price sums differ). Returns the three product ids + the bundle id. Module-level (not nested in one describe) so both the business-logic and route-layer suites below share it without duplicating the fixture. */
async function seedRamadanBox(storeId: string, tag: string) {
  const dates = await seedProduct(storeId, `${tag}-dates`, {
    price: 4500,
    inventory: 100,
  });
  const honey = await seedProduct(storeId, `${tag}-honey`, {
    price: 6000,
    inventory: 100,
  });
  const nuts = await seedProduct(storeId, `${tag}-nuts`, {
    price: 2000,
    inventory: 100,
  });
  const ramadanBox = await seedBundle(storeId, `${tag}-ramadan`, {
    name: 'Ramadan Box',
    pricingType: 'fixed_price',
    pricingValue: 12000,
    items: [
      { productId: dates, quantity: 1 },
      { productId: honey, quantity: 1 },
      { productId: nuts, quantity: 2 },
    ],
  });
  return { dates, honey, nuts, ramadanBox };
}

describe.skipIf(!hasDb)('atomic bundle returns', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;
  let customerId: string;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
    customerId = await seedCustomer(suffix);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refunds exactly the bundle price for a returned box — the allocated total, never the components shelf prices', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t1`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    const group = groupOf(order);

    const ret = await createBundleReturn(store.storeId, order, { bundleGroupIds: [group] });

    // Shelf-price sum would be 4500 + 6000 + 2000*2 = 14500. The allocated
    // total — what the customer actually paid for the box — is 12000. If
    // this ever reads 14500 (or anything but 12000), the refund is walking
    // more money out the door than the customer paid.
    expect(ret.refundAmount).toBe(12000);
    expect(ret.items).toHaveLength(3);
  });

  it('restocks every component of a returned box', async () => {
    const { dates, honey, nuts, ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t2`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    const group = groupOf(order);

    const before = {
      dates: await stockOf(dates),
      honey: await stockOf(honey),
      nuts: await stockOf(nuts),
    };

    const ret = await createBundleReturn(store.storeId, order, { bundleGroupIds: [group] });
    await prisma.return.update({ where: { id: ret.id }, data: { status: 'received' } });

    // Drive the real restock fanout directly (same lower-level entry point
    // partial-return-refund-effects.test.ts uses), with the exact item list
    // ReturnService.create synthesized from the bundle group.
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, {
      items: ret.items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      refundKey: ret.id,
      refundAmount: ret.refundAmount,
    });

    expect(await stockOf(dates)).toBe(before.dates + 1);
    expect(await stockOf(honey)).toBe(before.honey + 1);
    expect(await stockOf(nuts)).toBe(before.nuts + 2);
  });

  it('refuses a partial return of one component while returns are atomic', async () => {
    const { honey, ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t3`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    const honeyLine = order.items.find(i => i.productId === honey)!;

    await expect(
      createBundleReturn(store.storeId, order, {
        items: [
          {
            orderItemId: honeyLine.id,
            productId: honey,
            productName: honeyLine.productName,
            quantity: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ statusCode: 422, code: 'bundle_returns_are_atomic' });

    // Refused atomically — nothing was written.
    const returns = await prisma.return.findMany({ where: { orderId: order.id } });
    expect(returns).toHaveLength(0);
  });

  it('returning one box out of two refunds one box and restocks one box worth, leaving the other group intact', async () => {
    const { dates, honey, nuts, ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t4`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 2, { customerId });
    const groups = groupsOf(order);
    expect(groups).toHaveLength(2);
    const [groupA, groupB] = groups;

    const before = {
      dates: await stockOf(dates),
      honey: await stockOf(honey),
      nuts: await stockOf(nuts),
    };

    const ret = await createBundleReturn(store.storeId, order, { bundleGroupIds: [groupA] });
    // One box's worth, not the two-box total (24000).
    expect(ret.refundAmount).toBe(12000);
    expect(ret.items).toHaveLength(3);

    await prisma.return.update({ where: { id: ret.id }, data: { status: 'received' } });
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, {
      items: ret.items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      refundKey: ret.id,
      refundAmount: ret.refundAmount,
    });

    // Exactly one box's components restocked.
    expect(await stockOf(dates)).toBe(before.dates + 1);
    expect(await stockOf(honey)).toBe(before.honey + 1);
    expect(await stockOf(nuts)).toBe(before.nuts + 2);

    // Group B is untouched by the return above — its 3 lines are still on
    // the order at full quantity, and it can be returned independently for
    // its own full 12000 (proves the first return didn't consume or corrupt
    // the second box's claim).
    const groupBLines = order.items.filter(i => i.bundleGroupId === groupB);
    expect(groupBLines).toHaveLength(3);
    const ret2 = await createBundleReturn(store.storeId, order, { bundleGroupIds: [groupB] });
    expect(ret2.refundAmount).toBe(12000);
  });

  it('a return of a bundle group on an order that ALSO contains a loose line of the same product restocks the right quantities', async () => {
    const { honey, ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t5`);
    // 1 box (bundle honey component: qty 1) + a loose line of 3 more honey —
    // the exact shape that already broke twice in this plan (cart_items
    // uniqueness in Task 5, rollbackForPaymentFailure in Task 6).
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, {
      customerId,
      extraItems: [{ productId: honey, quantity: 3 }],
    });

    const honeyLines = order.items.filter(i => i.productId === honey);
    expect(honeyLines).toHaveLength(2);
    const bundleHoney = honeyLines.find(i => i.bundleGroupId)!;
    const looseHoney = honeyLines.find(i => !i.bundleGroupId)!;
    expect(bundleHoney.quantity).toBe(1);
    expect(looseHoney.quantity).toBe(3);

    const before = await stockOf(honey);
    const group = groupOf(order); // the loose line carries no bundleGroupId, so only the bundle's box counts here

    const ret = await createBundleReturn(store.storeId, order, { bundleGroupIds: [group] });
    const retHoneyItems = ret.items.filter(i => i.productId === honey);
    // Only the bundle's honey line came back — NOT the loose line.
    expect(retHoneyItems).toHaveLength(1);
    expect(retHoneyItems[0].orderItemId).toBe(bundleHoney.id);
    expect(retHoneyItems[0].quantity).toBe(1);

    await prisma.return.update({ where: { id: ret.id }, data: { status: 'received' } });
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, {
      items: ret.items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      refundKey: ret.id,
      refundAmount: ret.refundAmount,
    });

    // Only the bundle's 1 unit restocked — the loose line's 3 units are
    // still with the customer.
    expect(await stockOf(honey)).toBe(before + 1);

    // The loose line remains independently returnable, and restocks its own
    // (different) quantity — proves the two OrderItem rows for the same
    // product were never conflated.
    const ret2 = await createBundleReturn(store.storeId, order, {
      items: [
        {
          orderItemId: looseHoney.id,
          productId: honey,
          productName: looseHoney.productName,
          quantity: 3,
        },
      ],
    });
    await prisma.return.update({ where: { id: ret2.id }, data: { status: 'received' } });
    await handleOrderRefunded(order.id, store.storeId, true, false, stepStub, {
      items: [{ orderItemId: looseHoney.id, quantity: 3 }],
      refundKey: ret2.id,
      refundAmount: ret2.refundAmount,
    });
    expect(await stockOf(honey)).toBe(before + 1 + 3);
  });

  it('complete() routes a bundle-group return through the SAME partial-effects path as any other return — no parallel refund mechanism', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t6`);
    // 2 boxes so returning one group is a PARTIAL return of the order (the
    // item-level `order/refunded` path), exactly like
    // partial-return-refund-effects.test.ts's own "manual method" case.
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 2, { customerId });
    const [groupA] = groupsOf(order);
    const ret = await createBundleReturn(store.storeId, order, { bundleGroupIds: [groupA] });
    await prisma.return.update({ where: { id: ret.id }, data: { status: 'received' } });

    const effectsSpy = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    await ReturnService.complete(store.storeId, ret.id, 'test-user', 'cash');

    expect(effectsSpy).toHaveBeenCalledTimes(1);
    const [calledStoreId, calledOrderId, options] = effectsSpy.mock.calls[0];
    expect(calledStoreId).toBe(store.storeId);
    expect(calledOrderId).toBe(order.id);
    // The exact same `partial` payload shape any non-bundle partial return
    // produces — no bundle-specific branch, no separate refund code path.
    expect(options?.partial).toMatchObject({
      refundKey: ret.id,
      refundAmount: 12000,
    });
    expect(options?.partial?.items).toHaveLength(3);
  });

  // --- RULING T7-b (fix-round-1, Finding 2): double-submit the SAME
  // bundleGroupId across two separate return requests. "Verified by
  // inspection that it's the same reservation mechanism loose lines use" is
  // exactly the sentence that precedes money leaving twice — this proves it
  // rather than asserting it.

  it('submitting a second return for the SAME bundleGroupId is refused by the same reservation accounting that bounds loose lines', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-t7`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    const group = groupOf(order);

    const first = await createBundleReturn(store.storeId, order, { bundleGroupIds: [group] });
    expect(first.refundAmount).toBe(12000);
    // First request is still 'pending' — not completed, not consumed — but
    // `create()`'s `priorReturns` query claims quantity for anything not
    // rejected/cancelled, exactly like a loose line's cumulative-claim check.
    expect(first.status).toBe('pending');

    // Naming the SAME box again must be refused: every one of its 3
    // component lines is already claimed at its full ordered quantity, so
    // `alreadyClaimed + item.quantity > orderItem.quantity` trips for each —
    // the identical INVALID_QUANTITY guard a second loose-line return hits.
    await expect(
      createBundleReturn(store.storeId, order, { bundleGroupIds: [group] })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QUANTITY' });

    // Refused atomically — only the first return's row exists.
    const returns = await prisma.return.findMany({ where: { orderId: order.id } });
    expect(returns).toHaveLength(1);
    expect(returns[0].id).toBe(first.id);
  });
});

/**
 * Route-layer coverage (return.routes.ts) — fix-round-1, Finding 1.
 *
 * The business-logic suite above calls `ReturnService.create` directly,
 * which proved the service-level contract but left the ACTUAL HTTP path
 * (`POST /stores/:storeId/returns`'s Zod schema + `authenticate` gate)
 * completely unexercised for `bundleGroupIds`. Before this fix round, the
 * route's Zod schema had no `bundleGroupIds` field at all, so a real
 * request carrying only `bundleGroupIds` would strip that field silently
 * (Zod drops unknown keys by default), fail `items`'s `.min(1)`, and 400
 * with `VALIDATION_ERROR` — a customer sending exactly the request the
 * service was built to accept could never reach it.
 */
describe.skipIf(!hasDb)('atomic bundle returns — route layer (return.routes.ts)', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}-route`;
  let store: FixtureStore;
  let customerId: string;
  let app: ReturnType<typeof buildReturnTestApp>;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
    customerId = await seedCustomer(suffix);
    app = buildReturnTestApp();
  });

  it('a request with only bundleGroupIds succeeds end-to-end over HTTP', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-rt1`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    await markOrderDelivered(order.id);
    const group = groupOf(order);

    const res = await returnsClientFor(app, store.storeId, customerId).create({
      orderId: order.id,
      type: 'refund',
      reason: 'defective',
      bundleGroupIds: [group],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.return.refundAmount).toBe(12000);
    expect(res.body.data.return.items).toHaveLength(3);
  });

  it('a malformed bundleGroupIds is rejected by Zod before reaching the service', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-rt2`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    await markOrderDelivered(order.id);

    const res = await returnsClientFor(app, store.storeId, customerId).create({
      orderId: order.id,
      type: 'refund',
      reason: 'defective',
      bundleGroupIds: ['not-a-uuid'],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    // Never reached the service — no Return row was written.
    const returns = await prisma.return.findMany({ where: { orderId: order.id } });
    expect(returns).toHaveLength(0);
  });

  it('a request naming a bundle-component orderItemId in items is still refused with bundle_returns_are_atomic', async () => {
    const { honey, ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-rt3`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    await markOrderDelivered(order.id);
    const honeyLine = order.items.find(i => i.productId === honey)!;

    const res = await returnsClientFor(app, store.storeId, customerId).create({
      orderId: order.id,
      type: 'refund',
      reason: 'defective',
      items: [
        {
          orderItemId: honeyLine.id,
          productId: honey,
          productName: honeyLine.productName,
          quantity: 1,
        },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bundle_returns_are_atomic');
  });

  it('a request with NEITHER items NOR bundleGroupIds is still rejected, exactly as before this fix', async () => {
    const { ramadanBox } = await seedRamadanBox(store.storeId, `${suffix}-rt4`);
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    await markOrderDelivered(order.id);

    const res = await returnsClientFor(app, store.storeId, customerId).create({
      orderId: order.id,
      type: 'refund',
      reason: 'defective',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
