import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  category: { findFirst: vi.fn() },
  store: { findFirst: vi.fn() },
  exec: vi.fn(),
  moved: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: { product: db.product, category: db.category, store: db.store },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn({ $executeRaw: db.exec }),
  SlugEntityType: { PRODUCT: 'PRODUCT', CATEGORY: 'CATEGORY' },
}));
vi.mock('../../apps/api/src/services/slug-redirect.service', () => ({
  resolveSlugRedirectCached: db.moved,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  readQrSettings,
  recordQrScan,
  resolveQrScan,
} from '../../apps/api/src/services/qr.service';
import { DEFAULT_QR_SETTINGS } from '../../packages/shared/src/qr/schema';

beforeEach(() => {
  vi.clearAllMocks();
  db.moved.mockResolvedValue(null);
});

describe('resolveQrScan', () => {
  it('store code goes home and needs no lookup', async () => {
    expect(await resolveQrScan('s1', 'store')).toEqual({ kind: 'store', ref: '', target: '/' });
  });

  it('product code resolves a live product of THIS store only', async () => {
    db.product.findFirst.mockResolvedValue({ id: 'p1', slug: 'ring' });
    const r = await resolveQrScan('s1', 'product', 'ring');
    expect(r).toEqual({ kind: 'product', ref: 'p1', target: '/products/ring' });
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({
      storeId: 's1',
      status: 'active',
      deletedAt: null,
      audience: 'public',
    });
  });

  it('unknown or foreign slug is a 404', async () => {
    db.product.findFirst.mockResolvedValue(null);
    await expect(resolveQrScan('s1', 'product', 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveQrScan('s1', 'product')).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveQrScan('s1', 'category', 'x'.repeat(201))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('a renamed product slug still lands (slug-redirect fallback)', async () => {
    db.product.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1', slug: 'new' });
    db.moved.mockResolvedValue('new');
    const r = await resolveQrScan('s1', 'product', 'old');
    expect(r.target).toBe('/products/new');
  });

  it('category code lands on the filtered listing', async () => {
    db.category.findFirst.mockResolvedValue({ id: 'c1', slug: 'خواتم' });
    const r = await resolveQrScan('s1', 'category', 'خواتم');
    expect(r.target).toBe(`/products?category=${encodeURIComponent('خواتم')}`);
  });

  it('whatsapp code opens wa.me with the saved text, 404 without a number', async () => {
    db.store.findFirst.mockResolvedValue({
      whatsapp: '01012345678',
      settings: { qr: { ...DEFAULT_QR_SETTINGS, whatsappText: 'أهلاً' } },
    });
    const r = await resolveQrScan('s1', 'whatsapp');
    expect(r.target).toMatch(/^https:\/\/wa\.me\/20\d+\?text=/);
    db.store.findFirst.mockResolvedValue({ whatsapp: null, settings: {} });
    await expect(resolveQrScan('s1', 'whatsapp')).rejects.toMatchObject({ statusCode: 404 });
    db.store.findFirst.mockResolvedValue(null);
    await expect(resolveQrScan('s1', 'whatsapp')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('recordQrScan', () => {
  it('upserts one counter row', async () => {
    expect(await recordQrScan('s1', 'product', 'p1')).toBe(true);
    expect(db.exec).toHaveBeenCalled();
  });
  it('is fail-open: a DB error never throws', async () => {
    db.exec.mockRejectedValue(new Error('db down'));
    expect(await recordQrScan('s1', 'store', '')).toBe(false);
  });
});

describe('readQrSettings', () => {
  it('falls back to defaults for missing or corrupt stored settings', () => {
    expect(readQrSettings({})).toEqual(DEFAULT_QR_SETTINGS);
    expect(readQrSettings({ qr: { design: { fg: 'nope' } } })).toEqual(DEFAULT_QR_SETTINGS);
    expect(readQrSettings(null)).toEqual(DEFAULT_QR_SETTINGS);
  });
});
