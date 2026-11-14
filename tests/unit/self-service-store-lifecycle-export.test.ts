/** Store export bundle (A11): NDJSON per table + manifest, only the given store, capped. */
import { describe, it, expect, vi } from 'vitest';
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
describe('export bundle', () => {
  it('builds NDJSON per table + manifest from ONLY the given store, and refuses above the row cap', async () => {
    const { buildStoreBundle } = await import('@api/services/store-export.service');
    const rowsFor = (storeId: string) => ({
      product: [{ id: `${storeId}-p1`, name: 'P', storeId }],
      order: [{ id: `${storeId}-o1`, storeId, items: [] }],
    });
    const reader = vi.fn(async (storeId: string, table: string, take: number) =>
      ((rowsFor(storeId) as Record<string, unknown[]>)[table] ?? []).slice(0, take)
    );
    const r = await buildStoreBundle({
      storeId: 'store-a',
      tables: ['product', 'order', 'coupon'],
      read: reader,
      cap: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const { unzipSync, strFromU8 } = await import('fflate');
      const files = unzipSync(r.zip);
      expect(Object.keys(files).sort()).toEqual([
        'coupon.ndjson',
        'manifest.json',
        'order.ndjson',
        'product.ndjson',
      ]);
      expect(strFromU8(files['product.ndjson'])).toContain('store-a-p1');
      expect(strFromU8(files['product.ndjson'])).not.toContain('store-b');
      const manifest = JSON.parse(strFromU8(files['manifest.json']));
      expect(manifest.storeId).toBe('store-a');
      expect(manifest.tables.product).toBe(1);
    }
    for (const call of reader.mock.calls) expect(call[0]).toBe('store-a');
    const big = await buildStoreBundle({
      storeId: 'store-a',
      tables: ['product', 'order'],
      read: reader,
      cap: 1,
    });
    expect(big.ok).toBe(false);
  });
});

describe('export limiter', () => {
  it('allows one export per store per hour, then 429; another store is independent', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createStoreExportLimiter } = await import('@api/middleware/store-export-limiter');
    const app = express();
    app.get('/stores/:storeId/export', createStoreExportLimiter({ skip: () => false }), (_q, r) => {
      r.json({ ok: true });
    });
    expect((await request(app).get('/stores/s1/export')).status).toBe(200);
    expect((await request(app).get('/stores/s1/export')).status).toBe(429);
    expect((await request(app).get('/stores/s2/export')).status).toBe(200);
  });
});
