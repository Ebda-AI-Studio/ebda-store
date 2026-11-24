/**
 * Ported from tests/integration/repo-factory-orders-contract.test.ts ("personalisation text lands on the order item, and a delivery
 * date becomes the first line of the notes"; the Postgres original is deleted). Ruling B4-7 / CF-FINAL-1 on a store on its
 * Durable Object: `createOnDo` validates the delivery pick against the live store row (422 DELIVERY_SLOT_UNAVAILABLE, nothing
 * written), writes the delivery line as the FIRST line of the notes (then the shopper's own note), and hands each cart line's
 * personalisation note to the engine (`order_items.personalisation`). The pure resolver is delivery-date-resolver.test.ts and the
 * engine's own write is packages/repo/test/do-order-ops.test.ts; this pins the wiring between them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  createOrder: vi.fn(),
}));

vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeRepo: async () => ({
    backend: 'do',
    db: {
      store: {
        findUnique: async () => ({ settings: h.settings, timezone: 'Africa/Cairo' }),
      },
    },
  }),
  storeDb: async () => ({ product: { findMany: async () => [{ leadTimeDays: 0 }] } }),
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => false },
}));
vi.mock('../../apps/api/src/services/price-resolver.service', async importOriginal => ({
  ...(await importOriginal<object>()),
  wholesaleEntitledUncached: async () => false,
}));

import { deliveryDateChoices } from '@ebda/shared';
import { OrderService } from '../../apps/api/src/services/order.service';

const STORE = '11111111-1111-4111-8111-111111111111';
const createOnDo = (data: Record<string, unknown>, note: string | null = null): Promise<unknown> =>
  (
    OrderService as unknown as {
      createOnDo: (m: unknown, c: unknown) => Promise<unknown>;
    }
  ).createOnDo(
    { createOrder: h.createOrder, quoteOrder: vi.fn() },
    {
      storeId: STORE,
      customerId: undefined,
      data: { shippingAddress: {}, paymentMethod: 'cod', ...data },
      cart: {
        id: 'cart-1',
        items: [{ id: 'i1', productId: 'p1', quantity: 1, note, product: {} }],
        bundles: [],
      },
    }
  );

// the first date on offer for a 4-day window, computed with the same pure function the storefront and the order endpoint use
const firstDate = (): string =>
  (
    deliveryDateChoices({
      now: new Date(),
      timeZone: 'Africa/Cairo',
      offDays: [],
      windows: [],
      daysAhead: 4,
      estimateDays: 0,
      maxLeadTimeDays: 0,
    })[0] as { date: string }
  ).date;

beforeEach(() => {
  h.createOrder.mockReset();
  // the engine's answer is not under test: stop the post-commit code right after the call
  h.createOrder.mockRejectedValue(new Error('stop-after-engine'));
  h.settings = { checkoutDelivery: { daysAhead: 4 }, deliveryOffDays: [] };
});

describe('order create on a Durable Object store: delivery date and personalisation', () => {
  it('a web order without a date is refused 422 DELIVERY_SLOT_UNAVAILABLE and the engine is never called', async () => {
    await expect(createOnDo({})).rejects.toMatchObject({
      statusCode: 422,
      code: 'DELIVERY_SLOT_UNAVAILABLE',
    });
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it('a date outside the offered set is refused the same way', async () => {
    await expect(createOnDo({ deliveryDate: '1999-01-01' })).rejects.toMatchObject({
      code: 'DELIVERY_SLOT_UNAVAILABLE',
    });
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it('a valid date becomes the FIRST line of the notes, the shopper note follows, and the line carries its personalisation text', async () => {
    await expect(
      createOnDo(
        { deliveryDate: firstDate(), notes: 'ring twice', locale: 'en' },
        'Happy birthday Mona'
      )
    ).rejects.toThrow('stop-after-engine');
    const args = h.createOrder.mock.calls[0]![0] as {
      orderNotes: string;
      lines: Array<{ note?: string }>;
    };
    const [first, second, ...rest] = args.orderNotes.split('\n');
    expect(first).toMatch(/^Delivery: /);
    expect(second).toBe('ring twice');
    expect(rest).toEqual([]);
    expect(args.lines[0]!.note).toBe('Happy birthday Mona');
  });

  it('a store without daysAhead writes the shopper note untouched and validates nothing', async () => {
    h.settings = {};
    await expect(createOnDo({ deliveryDate: '1999-01-01', notes: 'ring' })).rejects.toThrow(
      'stop-after-engine'
    );
    expect((h.createOrder.mock.calls[0]![0] as { orderNotes: string }).orderNotes).toBe('ring');
  });
});
