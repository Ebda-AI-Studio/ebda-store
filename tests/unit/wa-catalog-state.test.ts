/**
 * `catalog.product_*` on ANY product / variant / stock write (contract section 4): the observer
 * classification, the job's current-state events and the link-flow resync.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), known: vi.fn() }));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.send }));
vi.mock('@api/lib/wa/link', () => ({ hasWhatsAppLinkRow: h.known }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CATALOG_CHANGED_EVENT,
  MAX_IDS_PER_EVENT,
  catalogChangeFrom,
  clearKnownStoreCache,
  notifyCatalogChanged,
} from '@api/lib/wa/catalog-state';

const S = '11111111-1111-4111-8111-111111111111';
const w = (model: string, operation: string, args: object, result: object = {}) => ({
  model,
  operation,
  args,
  result,
});

describe('catalogChangeFrom', () => {
  it.each([
    [
      'product create',
      w('Product', 'create', { data: { storeId: S, name: 'x' } }, { id: 'p1', storeId: S }),
      ['p1'],
    ],
    [
      'price update',
      w('Product', 'update', { where: { id: 'p1', storeId: S }, data: { price: 5 } }),
      ['p1'],
    ],
    [
      'soft delete',
      w('Product', 'update', { where: { id: 'p1', storeId: S }, data: { deletedAt: new Date() } }),
      ['p1'],
    ],
    ['hard delete', w('Product', 'delete', { where: { id: 'p1', storeId: S } }), ['p1']],
    [
      'bulk by id list',
      w('Product', 'updateMany', {
        where: { id: { in: ['a', 'b'] }, storeId: S },
        data: { status: 'active' },
      }),
      ['a', 'b'],
    ],
    [
      'variant price',
      w(
        'ProductVariant',
        'update',
        { where: { id: 'v1' }, data: { price: 9 } },
        { id: 'v1', productId: 'p7' }
      ),
      ['p7'],
    ],
    [
      'stock row',
      w(
        'WarehouseStock',
        'upsert',
        { where: { id: 'ws' }, create: { productId: 'p9', storeId: S }, update: {} },
        { productId: 'p9', storeId: S }
      ),
      ['p9'],
    ],
  ])('%s -> the store and its products', (_n, e, ids) => {
    expect(catalogChangeFrom(e, S)).toEqual({ storeId: S, productIds: ids });
  });

  it.each([
    [
      'a whole-store updateMany (gold reprice)',
      w('Product', 'updateMany', { where: { storeId: S }, data: { price: 1 } }),
    ],
    ['a bulk import', w('Product', 'createMany', { data: [{ storeId: S }] })],
    [
      'an id list over the cap',
      w('Product', 'updateMany', {
        where: {
          id: { in: Array.from({ length: MAX_IDS_PER_EVENT + 1 }, (_, i) => `p${i}`) },
          storeId: S,
        },
        data: {},
      }),
    ],
  ])('%s -> the whole catalog of the store', (_n, e) => {
    expect(catalogChangeFrom(e, S)).toEqual({ storeId: S, productIds: null });
  });

  it('takes the store from the ambient scope when the write carries none (variants)', () => {
    expect(
      catalogChangeFrom(
        w('ProductVariant', 'update', { where: { id: 'v' }, data: {} }, { productId: 'p1' }),
        S
      )
    ).toEqual({ storeId: S, productIds: ['p1'] });
    expect(
      catalogChangeFrom(
        w('ProductVariant', 'update', { where: { id: 'v' }, data: {} }, { productId: 'p1' }),
        undefined
      )
    ).toBeNull();
  });

  it.each([
    ['a read', w('Product', 'findMany', { where: { storeId: S } })],
    ['another model', w('Order', 'update', { where: { id: 'o' }, data: {} })],
  ])('%s -> nothing', (_n, e) => {
    expect(catalogChangeFrom(e, S)).toBeNull();
  });
});

describe('notifyCatalogChanged', () => {
  beforeEach(() => {
    clearKnownStoreCache();
    h.send.mockReset().mockResolvedValue(undefined);
    h.known.mockReset().mockResolvedValue(true);
  });

  it('sends after commit for a store Ebda Chat knows', async () => {
    await notifyCatalogChanged({ storeId: S, productIds: ['p1'] });
    expect(h.send).toHaveBeenCalledWith(
      'wa-catalog-changed',
      { name: CATALOG_CHANGED_EVENT, data: { storeId: S, productIds: ['p1'] } },
      { ifUnhookable: 'send' }
    );
  });

  it('a store it does not know costs ONE lookup per 30 s, not a job per product', async () => {
    h.known.mockResolvedValue(false);
    for (let i = 0; i < 50; i++) await notifyCatalogChanged({ storeId: S, productIds: [`p${i}`] });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.known).toHaveBeenCalledTimes(1);
  });
});
