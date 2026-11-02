/**
 * B0 Task 5: one variant can sit on several lines of one order ("Sara" and
 * "Omar" on the same abaya). Scan-to-pick must fill the first line still short
 * of its quantity, then move on — a bare findFirst capped every scan at the
 * first line and the order never reached fully-picked.
 *
 * Mutation proof: go back to picking `candidates[0]` → the second scan lands on
 * the already-full line and the test goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Line = { id: string; quantity: number; pickedQty: number; personalisation: string | null };
let lines: Line[] = [];
let selectSeen: Record<string, boolean> = {};
const update = vi.fn(async (_a: unknown) => undefined);

vi.mock('@ebda/database', () => ({
  prisma: {
    product: { findFirst: async () => null },
    productVariant: {
      findFirst: async () => ({
        id: 'v1',
        barcode: 'B1',
        sku: null,
        inventory: 5,
        title: 'M',
        titleAr: null,
        productId: 'p1',
        product: { name: 'Abaya', nameAr: null },
      }),
    },
    order: {
      findFirst: async (args: { select: { items: { select: Record<string, boolean> } } }) => {
        selectSeen = args.select.items.select;
        return {
          id: 'o1',
          orderNumber: 'N-1',
          status: 'processing',
          items: lines.map(l => ({
            ...l,
            productId: 'p1',
            variantId: 'v1',
            productName: 'Abaya',
            variantName: 'M',
            pickedAt: null,
          })),
        };
      },
    },
    orderItem: {
      findMany: async () =>
        lines.map(l => ({
          ...l,
          orderId: 'o1',
          productId: 'p1',
          variantId: 'v1',
          productName: 'Abaya',
        })),
      update: (a: never) => update(a),
    },
    // The atomic conditional UPDATE (id, qty, qty) or the remaining-lines count.
    $queryRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      if (strings.join('?').includes('UPDATE')) {
        const l = lines.find(x => x.id === vals[0]);
        if (!l || l.pickedQty >= l.quantity) return [];
        const before = l.pickedQty;
        l.pickedQty = Math.min(before + Number(vals[1]), l.quantity);
        return [{ before, after: l.pickedQty }];
      }
      return [{ remaining: BigInt(lines.filter(l => l.pickedQty < l.quantity).length) }];
    },
  },
  runInTenantContext: vi.fn(),
  Prisma: { sql: () => ({}), join: () => ({}), empty: {} },
}));

import { getOrderPickProgress, pickOrderItemByBarcode } from '@api/services/barcode-scan.service';

beforeEach(() => {
  lines = [
    { id: 'a', quantity: 1, pickedQty: 0, personalisation: 'Sara' },
    { id: 'b', quantity: 1, pickedQty: 0, personalisation: 'Omar' },
  ];
  update.mockClear();
});

describe('pickOrderItemByBarcode with personalised lines', () => {
  it('fills the first open line, then the next, and reports the order fully picked', async () => {
    const first = await pickOrderItemByBarcode('s1', 'o1', 'B1');
    expect(first.personalisation).toBe('Sara');
    expect(first.orderFullyPicked).toBe(false);
    const second = await pickOrderItemByBarcode('s1', 'o1', 'B1');
    expect(second.personalisation).toBe('Omar');
    expect(second.orderFullyPicked).toBe(true);
  });
});

describe('getOrderPickProgress', () => {
  it("selects and returns each line's personalisation for the scan-to-pick screen", async () => {
    const progress = await getOrderPickProgress('s1', 'o1');
    expect(selectSeen.personalisation).toBe(true);
    expect(progress.items.map(i => i.personalisation)).toEqual(['Sara', 'Omar']);
  });
});
