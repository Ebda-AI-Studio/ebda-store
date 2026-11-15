/** Store assistant confirm-class product tools (plan 4 C2): delete one product, bulk update up to 200. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolForbidden, effectivePolicy, type TurnCtx } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  getById: vi.fn(),
  del: vi.fn(),
  bulkUpdate: vi.fn(),
  getCategories: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: m.auditLog }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/services/product.service', () => ({
  ProductService: {
    getById: m.getById,
    delete: m.del,
    bulkUpdate: m.bulkUpdate,
    getCategories: m.getCategories,
    list: m.list,
  },
}));

import { applyThenUndo } from './helpers/undo-roundtrip';
import { productsConfirmTools } from '@api/smart-layer/tools/products-confirm.tools';

const S = '11111111-1111-4111-8111-111111111111';
const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: S,
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (name: string) => productsConfirmTools().find(x => x.name === name)!;
const parse = (name: string, a: unknown) => tool(name).args.parse(a) as never;
const auditActor = () => m.insertAuditLog.mock.calls.at(-1)![0].details.actor;

const prod = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Abaya ${id}`,
  price: 10000,
  status: 'active',
  featured: false,
  isNew: false,
  isBestSeller: false,
  inventory: 5,
  totalInventory: 5,
  variantCount: 0,
  pricingMode: null,
  ...over,
});
const DB: Record<string, ReturnType<typeof prod>> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(DB)) delete DB[k];
  for (let i = 1; i <= 30; i++) DB[`p${i}`] = prod(`p${i}`);
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.getById.mockImplementation(async (_s: string, id: string) => {
    if (!DB[id]) throw new Error('NOT_FOUND: product not in this store');
    return DB[id];
  });
  m.del.mockResolvedValue(undefined);
  m.bulkUpdate.mockImplementation(async (_s: string, ids: string[]) => ({
    updated: ids.length,
    skippedVariantProducts: 0,
  }));
  m.getCategories.mockResolvedValue([
    { id: 'virtual:best-sellers', name: 'Best Sellers', nameAr: 'x' },
    { id: 'c1', name: 'Abayas', nameAr: 'عبايات' },
  ]);
  m.list.mockImplementation(async () => ({
    products: Object.values(DB),
    meta: { total: Object.keys(DB).length },
  }));
});

describe('product_delete', () => {
  const t = () => tool('product_delete');
  it('is confirm-class, flags deletes, has no inverse, and effectivePolicy reports delete + irreversible', async () => {
    expect([t().policy, t().deletes, t().undo, t().inverse]).toEqual([
      'confirm',
      true,
      'irreversible',
      undefined,
    ]);
    const d = await t().preview!(ctx(), parse('product_delete', { productId: 'p1' }));
    const e = effectivePolicy(t(), d);
    expect(e.policy).toBe('confirm');
    expect(e.reasons).toEqual(expect.arrayContaining(['delete', 'irreversible']));
  });
  it('the card shows name, price in EGP and stock read from the store', async () => {
    const d = await t().preview!(ctx(), parse('product_delete', { productId: 'p1' }));
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(d.affectedCount).toBe(1);
    expect(d.rows.map(r => r.before)).toEqual(expect.arrayContaining(['Abaya p1', '100', 5]));
  });
  it('applies through runAsMerchant as the assistant with products:delete; staff is refused', async () => {
    const args = parse('product_delete', { productId: 'p1' });
    const draft = await t().preview!(ctx(), args);
    await t().apply!(ctx(), args, draft);
    expect(m.del).toHaveBeenCalledWith(S, 'p1');
    expect(auditActor()).toBe('assistant');
    expect(m.insertAuditLog.mock.calls[0]![0]).toMatchObject({
      action: 'product.deleted',
      resourceId: 'p1',
    });
    m.del.mockClear();
    await expect(t().apply!(ctx('staff'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    await expect(t().preview!(ctx('staff'), args)).rejects.toThrow();
    expect(m.del).not.toHaveBeenCalled();
  });
  it('a foreign product never reaches run', async () => {
    expect(t().refs!(parse('product_delete', { productId: 'x' }))).toEqual([
      { kind: 'product', id: 'x' },
    ]);
    await expect(
      t().preview!(ctx(), parse('product_delete', { productId: 'foreign' }))
    ).rejects.toThrow(/NOT_FOUND/);
    expect(m.del).not.toHaveBeenCalled();
  });
});

describe('products_bulk_update', () => {
  const t = () => tool('products_bulk_update');
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

  it('is confirm-class and compensating; a 10% change shows count, sample before/after and changesPrice', async () => {
    expect([t().policy, t().undo]).toEqual(['confirm', 'compensating']);
    const d = await t().preview!(
      ctx(),
      parse('products_bulk_update', { productIds: ids(3), pricePercent: -10 })
    );
    expect(d.changesPrice).toBe(true);
    expect(d.affectedCount).toBe(3);
    expect(d.rows[0]).toMatchObject({ before: 3, after: 3 });
    expect(d.rows.some(r => r.before === '100' && r.after === '90')).toBe(true);
    expect(effectivePolicy(t(), d).reasons).toEqual(expect.arrayContaining(['declared', 'price']));
  });
  it('a 25-product change has affectedCount 25 and escalates as bulk', async () => {
    const d = await t().preview!(
      ctx(),
      parse('products_bulk_update', { productIds: ids(25), status: 'draft' })
    );
    expect(d.affectedCount).toBe(25);
    expect(effectivePolicy(t(), d).reasons).toContain('bulk');
  });
  it('a category name resolves in the store; apply calls ProductService.bulkUpdate as the assistant', async () => {
    const args = parse('products_bulk_update', { categoryName: 'عبايات', pricePercent: -10 });
    const draft = await t().preview!(ctx(), args);
    expect(draft.affectedCount).toBe(30);
    await t().apply!(ctx(), args, draft);
    expect(m.list).toHaveBeenCalledWith(S, expect.objectContaining({ category: 'c1' }));
    expect(m.bulkUpdate).toHaveBeenCalledWith(S, ids(30).sort(), {
      price: { mode: 'adjustPct', value: -10 },
    });
    expect(auditActor()).toBe('assistant');
    expect(m.insertAuditLog.mock.calls[0]![0].action).toBe('product.bulk_update');
  });
  it('an unknown category, more than 200 products, or a store with none are refused before run', async () => {
    await expect(
      t().preview!(ctx(), parse('products_bulk_update', { categoryName: 'nope', status: 'draft' }))
    ).rejects.toThrow(/CATEGORY_NOT_FOUND/);
    m.list.mockResolvedValue({ products: [], meta: { total: 201 } });
    await expect(
      t().preview!(
        ctx(),
        parse('products_bulk_update', { categoryName: 'Abayas', status: 'draft' })
      )
    ).rejects.toThrow(/TOO_MANY/);
    expect(() =>
      t().args.parse({
        productIds: Array.from({ length: 201 }, (_, i) => `x${i}`),
        status: 'draft',
      })
    ).toThrow();
    expect(m.bulkUpdate).not.toHaveBeenCalled();
  });
  it('variant and gold-rate products keep their price and are counted as skipped', async () => {
    DB.p2 = prod('p2', { variantCount: 2 });
    DB.p3 = prod('p3', { pricingMode: 'gold_rate' });
    const d = await t().preview!(
      ctx(),
      parse('products_bulk_update', { productIds: ['p1', 'p2', 'p3'], pricePercent: 10 })
    );
    expect(d.affectedCount).toBe(1);
    expect(d.rows[1]).toMatchObject({ before: 2, after: 2 });
  });
  it('the inverse restores the before prices through the same tool and reads the same state (not stale)', async () => {
    DB.p2 = prod('p2', { price: 12345 });
    const args = parse('products_bulk_update', { productIds: ['p1', 'p2'], pricePercent: -10 });
    const draft = await t().preview!(ctx(), args);
    const inv = t().inverse!(ctx(), args, draft, { ok: true, etagAfter: 'x', result: {} })!;
    expect(inv.tool).toBe('products_bulk_update');
    expect(inv.args).toEqual({
      exact: [
        { productId: 'p1', price: 100 },
        { productId: 'p2', price: 123.45 },
      ],
    });
    const invArgs = parse('products_bulk_update', inv.args);
    expect((await t().preview!(ctx(), invArgs)).etag).toBe(draft.etag);
  });
  it('applying the inverse sets each distinct price back with bulkUpdate set (only products that differ)', async () => {
    DB.p1 = prod('p1', { price: 9000 }); // already discounted
    DB.p2 = prod('p2', { price: 9000 });
    const args = parse('products_bulk_update', {
      exact: [
        { productId: 'p1', price: 100 },
        { productId: 'p2', price: 90 },
      ],
    });
    const draft = await t().preview!(ctx(), args);
    expect(draft.affectedCount).toBe(1);
    await t().apply!(ctx(), args, draft);
    expect(m.bulkUpdate).toHaveBeenCalledTimes(1);
    expect(m.bulkUpdate).toHaveBeenCalledWith(S, ['p1'], { price: { mode: 'set', value: 10000 } });
  });
  it('store_admin only; a foreign product never reaches run; empty or mixed args are refused', async () => {
    const args = parse('products_bulk_update', { productIds: ['p1'], status: 'draft' });
    const draft = await t().preview!(ctx(), args);
    await expect(t().apply!(ctx('staff'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    await expect(
      t().preview!(
        ctx(),
        parse('products_bulk_update', { productIds: ['foreign'], status: 'draft' })
      )
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      t().preview!(ctx(), parse('products_bulk_update', { productIds: ['p1'] }))
    ).rejects.toThrow();
    await expect(
      t().preview!(
        ctx(),
        parse('products_bulk_update', { productIds: ['p1'], categoryName: 'x', status: 'draft' })
      )
    ).rejects.toThrow();
    expect(m.bulkUpdate).not.toHaveBeenCalled();
  });
  it('no argument is a store id; pricePercent is bounded', () => {
    expect(JSON.stringify(t().jsonSchema)).not.toMatch(/store_?id/i);
    expect(() => t().args.parse({ productIds: ['p1'], pricePercent: -95 })).toThrow();
  });
});

// ---- every tool: role + plan gates at preview and at apply; engine-level undo ------------------------------------------------------------------
const writes = () => [m.del, m.bulkUpdate];
const CASES: Array<[string, Record<string, unknown>, string[], string | null]> = [
  ['product_delete', { productId: 'p1' }, ['customer', 'staff'], null],
  [
    'products_bulk_update',
    { productIds: ['p1'], status: 'draft' },
    ['customer', 'staff'],
    'bulk_operations',
  ],
];
describe.each(CASES)('%s gates', (name, args, denied, feature) => {
  const t = () => tool(name);
  it.each(denied)('%s is refused at PREVIEW (no card is built)', async role => {
    await expect(t().preview!(ctx(role), parse(name, args))).rejects.toThrow(/FORBIDDEN/);
  });
  it.each(denied)(
    '%s is refused at APPLY with ToolForbidden and nothing is written',
    async role => {
      const a = parse(name, args);
      const draft = await t().preview!(ctx(), a);
      await expect(t().apply!(ctx(role), a, draft)).rejects.toBeInstanceOf(ToolForbidden);
      for (const fn of writes()) expect(fn).not.toHaveBeenCalled();
      expect(m.insertAuditLog).not.toHaveBeenCalled();
    }
  );
  it('a platform super admin never acts through it', async () => {
    await expect(t().preview!(ctx('super_admin'), parse(name, args))).rejects.toThrow(/FORBIDDEN/);
  });
  if (feature)
    it(`a plan without ${feature} is refused at preview and at apply`, async () => {
      const a = parse(name, args);
      const draft = await t().preview!(ctx(), a);
      m.featureEnabled.mockResolvedValue(false);
      await expect(t().preview!(ctx(), a)).rejects.toThrow(/feature/);
      await expect(t().apply!(ctx(), a, draft)).rejects.toBeInstanceOf(ToolForbidden);
      for (const fn of writes()) expect(fn).not.toHaveBeenCalled();
      expect(m.featureEnabled).toHaveBeenCalledWith(S, feature);
    });
});
describe('engine-level journal', () => {
  it('product_delete: confirm then apply, and undo says irreversible (no inverse)', async () => {
    const r = await applyThenUndo(
      productsConfirmTools(),
      tool('product_delete'),
      parse('product_delete', { productId: 'p1' })
    );
    expect(r).toMatchObject({ applied: 'applied', undo: 'irreversible' });
    expect(m.del).toHaveBeenCalledWith(S, 'p1');
  });
  it('products_bulk_update: confirm then apply; undo restores the before prices and its args pass validation', async () => {
    const t = tool('products_bulk_update');
    const a = parse('products_bulk_update', {
      productIds: ['p1', 'p2'],
      pricePercent: -10,
      status: 'draft',
    });
    const draft = await t.preview!(ctx(), a);
    const inv = t.inverse!(ctx(), a, draft, { ok: true, etagAfter: 'x' })!;
    expect(t.args.safeParse(inv.args).success).toBe(true);
    const r = await applyThenUndo(productsConfirmTools(), t, a);
    expect(r).toMatchObject({ applied: 'applied' });
    expect(['undone', 'needs_confirm']).toContain(r.undo);
    expect(m.bulkUpdate).toHaveBeenCalledWith(S, ['p1', 'p2'], {
      status: 'draft',
      price: { mode: 'adjustPct', value: -10 },
    });
  });
});
