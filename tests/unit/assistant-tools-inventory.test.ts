/** Store assistant inventory write tools (plan 4 B6): adjust, thresholds, reorder rules. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolForbidden, type TurnCtx } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  getById: vi.fn(),
  bulkThreshold: vi.fn(),
  adjust: vi.fn(),
  setInv: vi.fn(),
  updateThreshold: vi.fn(),
  getProductVariants: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
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
  ProductService: { getById: m.getById, bulkSetLowStockThreshold: m.bulkThreshold },
}));
vi.mock('@api/services/inventory.service', () => ({
  InventoryService: {
    adjustInventory: m.adjust,
    setInventory: m.setInv,
    updateThreshold: m.updateThreshold,
  },
}));
vi.mock('@api/services/variant.service', () => ({
  VariantService: { getProductVariants: m.getProductVariants },
}));
vi.mock('@api/services/accounting/reorder-rule.service', () => ({
  listReorderRules: m.listRules,
  createReorderRule: m.createRule,
  updateReorderRule: m.updateRule,
  deleteReorderRule: m.deleteRule,
}));

import { applyThenUndo } from './helpers/undo-roundtrip';
import { inventoryTools } from '@api/smart-layer/tools/inventory.tools';

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
const tool = (name: string) => {
  const t = inventoryTools().find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const parse = (name: string, a: unknown) => tool(name).args.parse(a) as never;
const preview = (name: string, a: unknown, role?: string) =>
  tool(name).preview!(ctx(role), parse(name, a));
const apply = async (name: string, a: unknown, role?: string) => {
  const args = parse(name, a);
  const draft = await tool(name).preview!(ctx(), args);
  return { args, draft, applied: await tool(name).apply!(ctx(role), args, draft) };
};
const auditActor = () => m.insertAuditLog.mock.calls.at(-1)![0].details.actor;

const DB: Record<string, Record<string, unknown>> = {};
const RULES: Array<Record<string, unknown>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(DB)) delete DB[k];
  RULES.length = 0;
  for (let i = 1; i <= 30; i++)
    DB[`p${i}`] = {
      id: `p${i}`,
      name: `P${i}`,
      nameAr: `م${i}`,
      inventory: 10,
      lowStockThreshold: 5,
      variants: [],
    };
  DB.pv = {
    id: 'pv',
    name: 'V',
    nameAr: 'V',
    inventory: 0,
    lowStockThreshold: 5,
    variants: [{ id: 'v1' }],
  };
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.getById.mockImplementation(async (_s: string, id: string) => {
    if (!DB[id]) throw new Error('NOT_FOUND: product not in this store');
    return DB[id];
  });
  m.adjust.mockResolvedValue({});
  m.setInv.mockResolvedValue({});
  m.updateThreshold.mockResolvedValue({});
  m.bulkThreshold.mockResolvedValue({ count: 1 });
  m.getProductVariants.mockResolvedValue({ variants: [{ id: 'v1' }] });
  m.listRules.mockImplementation(async () => RULES);
  m.createRule.mockResolvedValue({ id: 'r1' });
  m.updateRule.mockResolvedValue({ id: 'r1' });
  m.deleteRule.mockResolvedValue(undefined);
});

describe('tool list', () => {
  it('declares the inventory tools on inventory capabilities, with no store id argument', () => {
    const names = inventoryTools().map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'inventory_adjust',
        'inventory_set_threshold',
        'reorder_rule_set',
        'reorder_rule_delete',
      ])
    );
    for (const t of inventoryTools()) {
      expect(t.capabilityId).toMatch(/^inventory\./);
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });
});

describe('inventory_adjust', () => {
  it('previews before/after stock with an etag; delta applies through adjustInventory as the assistant', async () => {
    const t = tool('inventory_adjust');
    const args = parse('inventory_adjust', { productId: 'p1', delta: -3, reason: 'broken' });
    const d = await t.preview!(ctx(), args);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(d.rows[0]).toMatchObject({ before: 10, after: 7 });
    expect(d.affectedCount).toBe(1);
    await t.apply!(ctx(), args, d);
    expect(m.adjust).toHaveBeenCalledWith(
      S,
      expect.objectContaining({
        productId: 'p1',
        quantity: -3,
        type: 'manual_remove',
        reason: 'broken',
      }),
      'u1'
    );
    expect(auditActor()).toBe('assistant');
    expect(m.insertAuditLog.mock.calls[0]![0].action).toBe('inventory.adjusted');
  });
  it('an absolute count goes through setInventory and the inverse is the opposite delta', async () => {
    const t = tool('inventory_adjust');
    const args = parse('inventory_adjust', { productId: 'p1', setTo: 4 });
    const d = await t.preview!(ctx(), args);
    expect(d.rows[0]).toMatchObject({ before: 10, after: 4 });
    await t.apply!(ctx(), args, d);
    expect(m.setInv).toHaveBeenCalledWith(S, 'p1', 4, undefined, 'u1');
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'inventory_adjust',
      args: { productId: 'p1', delta: 6, reason: expect.any(String) },
    });
  });
  it('exactly one of delta and setTo; a no-op has no inverse', async () => {
    await expect(preview('inventory_adjust', { productId: 'p1' })).rejects.toThrow();
    await expect(
      preview('inventory_adjust', { productId: 'p1', delta: 1, setTo: 2 })
    ).rejects.toThrow();
    const t = tool('inventory_adjust');
    const args = parse('inventory_adjust', { productId: 'p1', setTo: 10 });
    const d = await t.preview!(ctx(), args);
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toBeNull();
  });
  it('refuses a variant product (stock lives on its variants) and a stock below zero', async () => {
    await expect(preview('inventory_adjust', { productId: 'pv', delta: 1 })).rejects.toThrow(
      /variant/i
    );
    await expect(preview('inventory_adjust', { productId: 'p1', delta: -50 })).rejects.toThrow();
  });
  it('needs inventory.basic and a role of the route; foreign id never reaches run', async () => {
    const t = tool('inventory_adjust');
    const args = parse('inventory_adjust', { productId: 'p1', delta: 1 });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.apply!(ctx(), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.adjust).not.toHaveBeenCalled();
    m.featureEnabled.mockResolvedValue(true);
    await expect(preview('inventory_adjust', { productId: 'foreign', delta: 1 })).rejects.toThrow(
      /NOT_FOUND/
    );
  });
});

describe('inventory_set_threshold', () => {
  it('a 25-product change has affectedCount 25', async () => {
    const productIds = Array.from({ length: 25 }, (_, i) => `p${i + 1}`);
    const d = await preview('inventory_set_threshold', { productIds, threshold: 3 });
    expect(d.affectedCount).toBe(25);
  });
  it('one product goes through updateThreshold, many through the bulk method, as the assistant', async () => {
    await apply('inventory_set_threshold', { productIds: ['p1'], threshold: 2 });
    expect(m.updateThreshold).toHaveBeenCalledWith(S, 'p1', 2);
    expect(auditActor()).toBe('assistant');
    await apply('inventory_set_threshold', { productIds: ['p1', 'p2'], threshold: 2 });
    expect(m.bulkThreshold).toHaveBeenCalledWith(S, ['p1', 'p2'], 2);
  });
  it('the inverse restores each product its own before threshold', async () => {
    DB.p2!.lowStockThreshold = 9;
    const t = tool('inventory_set_threshold');
    const args = parse('inventory_set_threshold', { productIds: ['p1', 'p2'], threshold: 1 });
    const draft = await t.preview!(ctx(), args);
    const inv = t.inverse!(ctx(), args, draft, { ok: true, etagAfter: 'x' })!;
    expect(inv.args).toEqual({
      changes: [
        { productId: 'p1', threshold: 5 },
        { productId: 'p2', threshold: 9 },
      ],
    });
    expect(() => t.args.parse(inv.args)).not.toThrow();
  });
  it('needs inventory.stock_alerts; forbidden role; foreign id blocked', async () => {
    const t = tool('inventory_set_threshold');
    const args = parse('inventory_set_threshold', { productIds: ['p1'], threshold: 1 });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    await expect(
      preview('inventory_set_threshold', { productIds: ['foreign'], threshold: 1 })
    ).rejects.toThrow();
    expect(m.updateThreshold).not.toHaveBeenCalled();
  });
});

describe('reorder_rule_set / reorder_rule_delete', () => {
  it('creates a rule when none exists (needs minQty and reorderQty), inverse deletes it', async () => {
    const t = tool('reorder_rule_set');
    const args = parse('reorder_rule_set', { productId: 'p1', minQty: 5, reorderQty: 20 });
    const d = await t.preview!(ctx(), args);
    expect(d.etag).toBeTruthy();
    const applied = await t.apply!(ctx(), args, d);
    expect(m.createRule).toHaveBeenCalledWith(
      S,
      expect.objectContaining({ productId: 'p1', minQty: 5, reorderQty: 20 })
    );
    expect(auditActor()).toBe('assistant');
    expect(t.inverse!(ctx(), args, d, applied)).toEqual({
      tool: 'reorder_rule_delete',
      args: { productId: 'p1' },
    });
    await expect(preview('reorder_rule_set', { productId: 'p1', minQty: 5 })).rejects.toThrow();
  });
  it('updates an existing rule and the inverse restores the previous values', async () => {
    RULES.push({
      id: 'r9',
      productId: 'p1',
      variantId: null,
      minQty: 2,
      reorderQty: 10,
      leadTimeDays: 3,
      safetyStockDays: 1,
      isActive: true,
    });
    const t = tool('reorder_rule_set');
    const args = parse('reorder_rule_set', { productId: 'p1', minQty: 8 });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    expect(m.updateRule).toHaveBeenCalledWith(S, 'r9', { minQty: 8 });
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'reorder_rule_set',
      args: {
        productId: 'p1',
        minQty: 2,
        reorderQty: 10,
        leadTimeDays: 3,
        safetyStockDays: 1,
        isActive: true,
      },
    });
  });
  it('the set and delete tools read the same state so an undo is not stale', async () => {
    RULES.push({
      id: 'r9',
      productId: 'p1',
      variantId: null,
      minQty: 2,
      reorderQty: 10,
      leadTimeDays: 3,
      safetyStockDays: 1,
      isActive: true,
    });
    const a = await preview('reorder_rule_set', { productId: 'p1', minQty: 8 });
    const b = await preview('reorder_rule_delete', { productId: 'p1' });
    expect(a.etag).toBe(b.etag);
  });
  it('delete is confirm-class, irreversible and flags deletes', async () => {
    const t = tool('reorder_rule_delete');
    expect([t.policy, t.undo, t.deletes]).toEqual(['confirm', 'irreversible', true]);
  });
  it('store_admin only (the route); a foreign product or variant never reaches run', async () => {
    const t = tool('reorder_rule_set');
    const args = parse('reorder_rule_set', { productId: 'p1', minQty: 5, reorderQty: 20 });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('staff'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    await expect(
      preview('reorder_rule_set', { productId: 'foreign', minQty: 1, reorderQty: 1 })
    ).rejects.toThrow();
    await expect(
      preview('reorder_rule_set', {
        productId: 'p1',
        variantId: 'not-mine',
        minQty: 1,
        reorderQty: 1,
      })
    ).rejects.toThrow();
    expect(m.createRule).not.toHaveBeenCalled();
  });
});

// ---- every tool: role + plan-feature gates at preview and at apply ---------------------------------------------------------------------------
const writes = () => [
  m.adjust,
  m.setInv,
  m.updateThreshold,
  m.bulkThreshold,
  m.createRule,
  m.updateRule,
  m.deleteRule,
];
const CASES: Array<[string, Record<string, unknown>, string[], boolean]> = [
  ['inventory_adjust', { productId: 'p1', delta: 1 }, ['customer'], true],
  ['inventory_set_threshold', { productIds: ['p1'], threshold: 2 }, ['customer'], true],
  [
    'reorder_rule_set',
    { productId: 'p1', minQty: 5, reorderQty: 20 },
    ['customer', 'staff'],
    false,
  ],
];
describe.each(CASES)('%s gates', (name, args, denied, hasFeature) => {
  it.each(denied)('%s is refused at PREVIEW (no card)', async role => {
    await expect(preview(name, args, role)).rejects.toThrow(/FORBIDDEN/);
  });
  it.each(denied)(
    '%s is refused at APPLY with ToolForbidden and nothing is written',
    async role => {
      const t = tool(name);
      const a = parse(name, args);
      const draft = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx(role), a, draft)).rejects.toBeInstanceOf(ToolForbidden);
      for (const fn of writes()) expect(fn).not.toHaveBeenCalled();
      expect(m.insertAuditLog).not.toHaveBeenCalled();
    }
  );
  if (hasFeature)
    it('a plan without the feature is refused at preview and at apply', async () => {
      const t = tool(name);
      const a = parse(name, args);
      const draft = await t.preview!(ctx(), a);
      m.featureEnabled.mockResolvedValue(false);
      await expect(t.preview!(ctx(), a)).rejects.toThrow(/feature/);
      await expect(t.apply!(ctx(), a, draft)).rejects.toBeInstanceOf(ToolForbidden);
      for (const fn of writes()) expect(fn).not.toHaveBeenCalled();
      expect(m.featureEnabled).toHaveBeenCalledWith(
        S,
        name === 'inventory_adjust' ? 'inventory.basic' : 'inventory.stock_alerts'
      );
    });
});
it('reorder_rule_delete: role gate at preview and apply', async () => {
  RULES.push({
    id: 'r9',
    productId: 'p1',
    variantId: null,
    minQty: 2,
    reorderQty: 10,
    leadTimeDays: 3,
    safetyStockDays: 1,
    isActive: true,
  });
  await expect(preview('reorder_rule_delete', { productId: 'p1' }, 'staff')).rejects.toThrow(
    /FORBIDDEN/
  );
  const t = tool('reorder_rule_delete');
  const a = parse('reorder_rule_delete', { productId: 'p1' });
  const draft = await t.preview!(ctx(), a);
  await expect(t.apply!(ctx('staff'), a, draft)).rejects.toBeInstanceOf(ToolForbidden);
  expect(m.deleteRule).not.toHaveBeenCalled();
});

// ---- engine-level undo ----------------------------------------------------------------------------------------------------------------------
describe('undo round trips through the engine', () => {
  const all = () => inventoryTools();
  it('reorder_rule_set (create): undo is the confirm card of the delete, built from the rule that was created', async () => {
    m.createRule.mockImplementation(async () => {
      RULES.push({
        id: 'r1',
        productId: 'p1',
        variantId: null,
        minQty: 5,
        reorderQty: 20,
        leadTimeDays: 0,
        safetyStockDays: 0,
        isActive: true,
      });
      return { id: 'r1' };
    });
    const r = await applyThenUndo(
      all(),
      tool('reorder_rule_set'),
      parse('reorder_rule_set', { productId: 'p1', minQty: 5, reorderQty: 20 })
    );
    expect(r).toMatchObject({ applied: 'applied', undo: 'needs_confirm' });
    expect(r.card).toBeTruthy();
  });
  it('reorder_rule_set (update): undone, and its restore carries no null', async () => {
    RULES.push({
      id: 'r9',
      productId: 'p1',
      variantId: null,
      minQty: 2,
      reorderQty: 10,
      leadTimeDays: null,
      safetyStockDays: 1,
      isActive: true,
    });
    const t = tool('reorder_rule_set');
    const a = parse('reorder_rule_set', { productId: 'p1', minQty: 8 });
    const draft = await t.preview!(ctx(), a);
    const restore = (draft.payload as { restore: Record<string, unknown> }).restore;
    expect(Object.values(restore)).not.toContain(null);
    expect(t.inverse!(ctx(), a, draft, { ok: true, etagAfter: 'x' })!.args).toEqual({
      productId: 'p1',
      ...restore,
    });
    expect((await applyThenUndo(all(), t, a)).undo).toBe('undone');
  });
  it('inventory_adjust and inventory_set_threshold: undone, undo args valid', async () => {
    for (const [name, args] of [
      ['inventory_adjust', { productId: 'p1', delta: -3 }],
      ['inventory_adjust', { productId: 'p1', setTo: 4 }],
      ['inventory_set_threshold', { productIds: ['p1', 'p2'], threshold: 1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const t = tool(name);
      const a = parse(name, args);
      const draft = await t.preview!(ctx(), a);
      expect(
        t.args.safeParse(t.inverse!(ctx(), a, draft, { ok: true, etagAfter: 'x' })!.args).success
      ).toBe(true);
      expect((await applyThenUndo(all(), t, a)).undo).toBe('undone');
    }
  });
});

it('a tool whose undo is a different tool declares compensating, never reversible', () => {
  for (const n of ['reorder_rule_set']) expect(tool(n).undo).toBe('compensating');
});
