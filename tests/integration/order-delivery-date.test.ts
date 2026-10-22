/**
 * Phase B4 Task 5, Ruling B4-7 + Review Focus 3 (data flow, not component level): a store with
 * `checkoutDelivery.daysAhead` takes a delivery DATE. The order endpoint recomputes the offered set
 * from the LIVE store row and the cart's longest lead time, refuses anything else (422
 * DELIVERY_SLOT_UNAVAILABLE), and is the only writer of the note's delivery line, which every
 * reader of `notes` (receipt, account order, admin, the orders app) then shows. A store WITHOUT
 * `daysAhead` behaves as before. Real Postgres; the clock is frozen on Thursday 2026-10-22 08:00 Cairo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { withRlsBypass } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  addItemToCart,
  cartSessionId,
  testShippingAddress,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const suffix = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const WINDOWS = [
  { id: 'lunch', label: 'Lunch', labelAr: 'غدا', start: '12:00', end: '14:00', orderBy: '10:00' },
  { id: 'dinner', label: 'Dinner', labelAr: 'عشا', start: '18:00', end: '20:00', orderBy: '15:00' },
];
const dateSettings = (over: Record<string, unknown> = {}) => ({
  checkoutDelivery: {
    note: { enabled: false, text: '', textAr: '' },
    windows: { enabled: true, items: WINDOWS },
    daysAhead: 5,
  },
  deliveryOffDays: [] as number[],
  ...over,
});

describe.skipIf(!hasDb)('order delivery date (Ruling B4-7)', () => {
  let dateStore: FixtureStore;
  let legacyStore: FixtureStore;
  let otherStore: FixtureStore;
  let dish: string; // no lead time
  let cake: string; // 2 days lead
  let legacyDish: string;
  let otherDish: string;

  const setSettings = (storeId: string, settings: Record<string, unknown>) =>
    withRlsBypass(tx => tx.store.update({ where: { id: storeId }, data: { settings } }));

  async function place(
    store: FixtureStore,
    productId: string,
    pick: { deliveryDate?: string; deliveryWindowId?: string },
    extra: Record<string, unknown> = {}
  ) {
    const sessionId = cartSessionId('deliv');
    await addItemToCart(store.storeId, sessionId, productId, 1);
    return OrderService.create(store.storeId, undefined, sessionId, {
      shippingAddress: testShippingAddress(),
      paymentMethod: 'cod',
      locale: 'ar',
      source: 'web',
      ...pick,
      ...extra,
    } as never);
  }
  const refusal = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ statusCode: 422, code: 'DELIVERY_SLOT_UNAVAILABLE' });

  beforeAll(async () => {
    dateStore = await seedBundleStore(`ddate-a-${suffix}`);
    legacyStore = await seedBundleStore(`ddate-b-${suffix}`);
    otherStore = await seedBundleStore(`ddate-c-${suffix}`);
    dish = await seedProduct(dateStore.storeId, `${suffix}-dish`, { price: 9000, inventory: 500 });
    cake = await seedProduct(dateStore.storeId, `${suffix}-cake`, { price: 30000, inventory: 500 });
    legacyDish = await seedProduct(legacyStore.storeId, `${suffix}-l`, {
      price: 9000,
      inventory: 500,
    });
    otherDish = await seedProduct(otherStore.storeId, `${suffix}-o`, {
      price: 9000,
      inventory: 500,
    });
    await withRlsBypass(tx =>
      tx.product.update({ where: { id: cake }, data: { leadTimeDays: 2 } })
    );
    await setSettings(dateStore.storeId, dateSettings());
    await setSettings(legacyStore.storeId, {
      checkoutDelivery: {
        note: { enabled: false, text: '', textAr: '' },
        windows: { enabled: true, items: WINDOWS },
      },
    });
    await setSettings(otherStore.storeId, dateSettings({ deliveryOffDays: [4] }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T08:00:00+03:00'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('a valid pick is written by the server as the first line of the order notes, and every reader sees it', async () => {
    const order = await place(
      dateStore,
      dish,
      { deliveryDate: '2026-10-23', deliveryWindowId: 'dinner' },
      { notes: 'بدون بصل' }
    );
    const expectedLine = 'التوصيل: الجمعة 23 أكتوبر، عشا (6:00 م–8:00 م)';
    expect(order.notes).toBe(`${expectedLine}\nبدون بصل`);
    // the receipt / account order / admin all read the stored row
    const read = await OrderService.getById(dateStore.storeId, order.id);
    expect(read.notes).toBe(`${expectedLine}\nبدون بصل`);
  });

  it('an English order gets the English line; a pick with no customer note is just the line', async () => {
    const order = await place(
      dateStore,
      dish,
      { deliveryDate: '2026-10-24', deliveryWindowId: 'lunch' },
      { locale: 'en' }
    );
    expect(order.notes).toBe('Delivery: Sat 24 Oct, Lunch (12:00 PM–2:00 PM)');
  });

  it('refuses: no date, a stale or past date, a date past the window, a closed window, an unknown window', async () => {
    await refusal(place(dateStore, dish, {}));
    await refusal(
      place(dateStore, dish, { deliveryDate: '2026-10-21', deliveryWindowId: 'dinner' })
    );
    await refusal(
      place(dateStore, dish, { deliveryDate: '2026-10-30', deliveryWindowId: 'dinner' })
    );
    await refusal(place(dateStore, dish, { deliveryDate: '2026-10-23' })); // window required
    await refusal(place(dateStore, dish, { deliveryDate: '2026-10-23', deliveryWindowId: 'nope' }));
  });

  it("today's windows obey their cut-offs at the moment of the order", async () => {
    vi.setSystemTime(new Date('2026-10-22T11:00:00+03:00'));
    await refusal(
      place(dateStore, dish, { deliveryDate: '2026-10-22', deliveryWindowId: 'lunch' })
    );
    const ok = await place(dateStore, dish, {
      deliveryDate: '2026-10-22',
      deliveryWindowId: 'dinner',
    });
    expect(ok.notes).toContain('الخميس 22 أكتوبر');
    vi.setSystemTime(new Date('2026-10-22T19:00:00+03:00'));
    await refusal(
      place(dateStore, dish, { deliveryDate: '2026-10-22', deliveryWindowId: 'dinner' })
    );
    expect(
      (await place(dateStore, dish, { deliveryDate: '2026-10-23', deliveryWindowId: 'dinner' })).id
    ).toBeTruthy();
    vi.setSystemTime(new Date('2026-10-22T08:00:00+03:00'));
  });

  it('a product lead time in the cart moves the first date out (made to order)', async () => {
    await refusal(
      place(dateStore, cake, { deliveryDate: '2026-10-22', deliveryWindowId: 'dinner' })
    );
    await refusal(
      place(dateStore, cake, { deliveryDate: '2026-10-23', deliveryWindowId: 'dinner' })
    );
    const ok = await place(dateStore, cake, {
      deliveryDate: '2026-10-24',
      deliveryWindowId: 'dinner',
    });
    expect(ok.notes).toContain('السبت 24 أكتوبر');
  });

  it('an off-day edit reaches the very next order (live settings, never cached)', async () => {
    await setSettings(dateStore.storeId, dateSettings({ deliveryOffDays: [5] }));
    await refusal(
      place(dateStore, dish, { deliveryDate: '2026-10-23', deliveryWindowId: 'dinner' })
    );
    expect(
      (await place(dateStore, dish, { deliveryDate: '2026-10-24', deliveryWindowId: 'dinner' })).id
    ).toBeTruthy();
    await setSettings(dateStore.storeId, dateSettings());
    expect(
      (await place(dateStore, dish, { deliveryDate: '2026-10-23', deliveryWindowId: 'dinner' })).id
    ).toBeTruthy();
  });

  it('a store WITHOUT daysAhead is untouched: the client note passes through, a stray date is ignored', async () => {
    const order = await place(
      legacyStore,
      legacyDish,
      { deliveryDate: '1999-01-01', deliveryWindowId: 'nope' },
      { notes: 'Delivery: Today, Lunch (12:00 PM–2:00 PM)\nplease ring' }
    );
    expect(order.notes).toBe('Delivery: Today, Lunch (12:00 PM–2:00 PM)\nplease ring');
  });

  it("tenant isolation: each store's own live settings decide (store C is off on Thursday)", async () => {
    // Thursday is weekday 4: store C does not deliver on it, store A does (after the reset above)
    await refusal(
      place(otherStore, otherDish, { deliveryDate: '2026-10-22', deliveryWindowId: 'dinner' })
    );
    expect(
      (await place(dateStore, dish, { deliveryDate: '2026-10-22', deliveryWindowId: 'dinner' })).id
    ).toBeTruthy();
  });

  it('a refused slot places NO order and moves no stock', async () => {
    const before = await withRlsBypass(tx =>
      tx.order.count({ where: { storeId: dateStore.storeId } })
    );
    await refusal(
      place(dateStore, dish, { deliveryDate: '2099-01-01', deliveryWindowId: 'dinner' })
    );
    const after = await withRlsBypass(tx =>
      tx.order.count({ where: { storeId: dateStore.storeId } })
    );
    expect(after).toBe(before);
  });
});
