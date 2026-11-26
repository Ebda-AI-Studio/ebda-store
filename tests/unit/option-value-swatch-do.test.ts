/**
 * Ported from tests/integration/option-value-swatch.test.ts (Postgres, ebda_app login). The real VariantService runs against the
 * StoreDO schema on node:sqlite through prisma-lite (the same wiring as bulk-do-roundtrip.test.ts): swatch on create, independent
 * update (undefined leaves alone, null clears), addOptionValue with a swatch, delete of a value/option, the schema CHECK that
 * refuses a malformed hex, and the route schema. The cache bust after each write is asserted by call count.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { optionValueSwatchSchema } from '@ebda/shared';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const raw = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;
const STORE = 'swatch-store';
const busts = vi.hoisted(() => ({ n: 0 }));

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeWriter: async () => lite,
  storeDb: async () => lite,
  storeMoney: async () => ({}),
  storeStock: async () => ({}),
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: async () => void busts.n++,
}));
vi.mock('../../apps/api/src/lib/wa/catalog-state', () => ({ notifyCatalogChanged: () => {} }));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  deleteR2ObjectIfOrphan: async () => undefined,
}));

import { VariantService } from '../../apps/api/src/services/variant.service';

const ids = { product: 'p1', option: '', teal: '' };
const values = async () =>
  (await lite.productOption.findMany({
    where: { productId: ids.product },
    include: { values: { orderBy: { position: 'asc' } } },
  })) as Array<{ id: string; values: Array<Record<string, any>> }>;
const flat = async () => (await values()).flatMap(o => o.values);

beforeAll(() => {
  raw
    .prepare(
      `INSERT INTO products (id, store_id, name, slug, price, status) VALUES ('p1', '${STORE}', 'tee', 'tee', 10000, 'active')`
    )
    .run();
});

describe('option value swatches on the StoreDO schema (in order)', () => {
  it('stores a swatch on create and reads it back (null when unset, never undefined)', async () => {
    const opt = await VariantService.addOption(STORE, ids.product, {
      name: 'Color',
      nameAr: 'اللون',
      values: [{ value: 'Teal', valueAr: 'تيل', swatchHex: '#1F4E54' }, { value: 'Plain' }],
    });
    ids.option = opt.id;
    const vs = await flat();
    const teal = vs.find(v => v.value === 'Teal')!;
    const plain = vs.find(v => v.value === 'Plain')!;
    ids.teal = teal.id;
    expect(teal.swatchHex).toBe('#1F4E54');
    expect(teal.swatchImageUrl).toBeNull();
    expect(plain.swatchHex).toBeNull();
    expect(plain.swatchImageUrl).toBeNull();
  });

  it('updates image and hex independently; undefined leaves alone, null clears', async () => {
    await VariantService.updateOptionValue(STORE, ids.product, ids.teal, {
      swatchImageUrl: 'https://x.r2.dev/teal.webp',
    });
    let teal = (await flat()).find(v => v.id === ids.teal)!;
    expect(teal.swatchHex).toBe('#1F4E54'); // untouched
    expect(teal.swatchImageUrl).toBe('https://x.r2.dev/teal.webp');

    await VariantService.updateOptionValue(STORE, ids.product, ids.teal, { swatchHex: null });
    teal = (await flat()).find(v => v.id === ids.teal)!;
    expect(teal.swatchHex).toBeNull();
    expect(teal.swatchImageUrl).toBe('https://x.r2.dev/teal.webp');
  });

  it('addOptionValue accepts a swatch', async () => {
    await VariantService.addOptionValue(STORE, ids.product, ids.option, {
      value: 'Sand',
      swatchHex: '#C2B280',
    });
    expect((await flat()).find(v => v.value === 'Sand')!.swatchHex).toBe('#C2B280');
  });

  it('deleting a value or an option removes it, busts the public cache each time, and cascades the values', async () => {
    const before = busts.n;
    const sandId = (await flat()).find(v => v.value === 'Sand')!.id;
    await VariantService.deleteOptionValue(STORE, ids.product, sandId);
    expect((await flat()).some(v => v.value === 'Sand')).toBe(false);
    await VariantService.deleteOption(STORE, ids.product, ids.option);
    expect(await values()).toHaveLength(0);
    expect(
      (raw.prepare('SELECT COUNT(*) n FROM product_option_values').get() as { n: number }).n
    ).toBe(0);
    expect(busts.n).toBeGreaterThanOrEqual(before + 2);
  });

  it('rejects a bad hex at the route schema and at the schema CHECK', () => {
    expect(optionValueSwatchSchema.safeParse({ swatchHex: 'red' }).success).toBe(false);
    expect(
      optionValueSwatchSchema.safeParse({ swatchHex: null, swatchImageUrl: null }).success
    ).toBe(true);
    raw
      .prepare(`INSERT INTO product_options (id, product_id, name) VALUES ('o9', 'p1', 'Shade')`)
      .run();
    raw
      .prepare(`INSERT INTO product_option_values (id, option_id, value) VALUES ('v9', 'o9', 'K')`)
      .run();
    expect(() =>
      raw.prepare(`UPDATE product_option_values SET swatch_hex = 'red' WHERE id = 'v9'`).run()
    ).toThrow();
  });
});
