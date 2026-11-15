/**
 * Wave 1 (plan 4 B6): inventory write tools of the Store assistant (stock adjust, low-stock thresholds, reorder rules). Gates mirror the admin
 * routes line for line (cited per tool); stock goes through InventoryService exactly like the Merchant MCP admin_adjust_inventory /
 * admin_set_inventory tools; reorder rules go through the accounting reorder-rule service the route calls.
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { ProductService } from '../../services/product.service';
import { InventoryService } from '../../services/inventory.service';
import { VariantService } from '../../services/variant.service';
import {
  createReorderRule,
  deleteReorderRule,
  listReorderRules,
  updateReorderRule,
} from '../../services/accounting/reorder-rule.service';
import { change, f, pair, row, shape } from './kit';

type Obj = Record<string, unknown>;
const productRef = (id: string) => ({ kind: 'product', id });
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const CHUNK = 10;
async function mapChunked<T, R>(xs: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += CHUNK)
    out.push(...(await Promise.all(xs.slice(i, i + CHUNK).map(fn))));
  return out;
}

// ---- inventory_adjust ------------------------------------------------------------------------------------------------------------------------
type AdjustArgs = { productId: string; delta?: number; setTo?: number; reason?: string };
const stockOf = async (storeId: string, productId: string) => {
  const p = (await ProductService.getById(storeId, productId)) as Obj & { variants?: unknown[] };
  return {
    id: p.id,
    name: p.name ?? null,
    inventory: Number(p.inventory ?? 0),
    hasVariants: (p.variants?.length ?? 0) > 0,
  };
};
const adjustment = (a: AdjustArgs, current: number) => {
  if ((a.delta === undefined) === (a.setTo === undefined))
    throw new Error('send exactly one of "delta" (signed change) and "setTo" (counted total)');
  return a.delta !== undefined ? a.delta : (a.setTo as number) - current;
};

const adjust = change<AdjustArgs>({
  name: 'inventory_adjust',
  capabilityId: 'inventory.overview-adjust',
  description:
    'Change the stock of ONE simple product: `delta` is a signed whole number (+10 adds, -3 removes) or `setTo` is the counted total. Exactly one of them. ' +
    'Products with variants keep stock on the variants and are refused. Always give a short reason.',
  schema: shape<AdjustArgs>(
    {
      productId: f.id('The product id'),
      delta: f.int('Signed change in units, e.g. -3 or 10', { min: -1_000_000, max: 1_000_000 }),
      setTo: f.int('Counted total in units (0 or more)', { max: 1_000_000 }),
      reason: f.text('Why (e.g. damaged, recount)', { max: 200 }),
    },
    ['productId']
  ),
  undo: 'compensating',
  // inventory.routes.ts POST /adjust and PUT /products/:productId/set: authorize('store_admin', 'super_admin', 'staff') + requireFeature('inventory.basic').
  gate: { roles: ['store_admin', 'staff'], feature: 'inventory.basic' },
  audit: { action: 'inventory.adjusted', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: async (ctx, a) => {
    const s = await stockOf(ctx.storeId, a.productId);
    return { id: s.id, inventory: s.inventory, hasVariants: s.hasVariants };
  },
  describe: (_ctx, a, state) => {
    const s = state as { id: string; inventory: number; hasVariants: boolean };
    if (s.hasVariants)
      throw new Error(
        'VARIANT_PRODUCT: this product tracks stock on its variants; adjust the variant stock instead.'
      );
    const delta = adjustment(a, s.inventory);
    const after = s.inventory + delta;
    if (after < 0) throw new Error('INSUFFICIENT_STOCK: cannot reduce stock below zero.');
    return {
      summary: pair(
        `هغيّر المخزون من ${s.inventory} إلى ${after} (${delta >= 0 ? '+' : ''}${delta}).`,
        `Change stock from ${s.inventory} to ${after} (${delta >= 0 ? '+' : ''}${delta}).`
      ),
      rows: [row('المخزون', 'Stock', s.inventory, after)],
      affectedCount: 1,
      restore: { productId: a.productId, delta: -delta },
    };
  },
  run: async (ctx, a, state) => {
    const s = state as { inventory: number };
    const delta = adjustment(a, s.inventory);
    if (delta === 0) return { unchanged: true };
    // the same two calls as the Merchant MCP tools: a count goes through setInventory, a delta through adjustInventory
    if (a.setTo !== undefined)
      return InventoryService.setInventory(ctx.storeId, a.productId, a.setTo, a.reason, ctx.userId);
    return InventoryService.adjustInventory(
      ctx.storeId,
      {
        productId: a.productId,
        quantity: delta,
        type: delta > 0 ? 'manual_add' : 'manual_remove',
        reason: a.reason,
      },
      ctx.userId
    );
  },
  inverse: (_a, restore) => {
    const r = restore as { productId: string; delta: number };
    return r.delta === 0
      ? null
      : {
          tool: 'inventory_adjust',
          args: {
            productId: r.productId,
            delta: r.delta,
            reason: 'Undo of an assistant stock change',
          },
        };
  },
});

// ---- inventory_set_threshold -----------------------------------------------------------------------------------------------------------------
type ThrArgs = {
  productIds?: string[];
  threshold?: number;
  changes?: Array<{ productId: string; threshold: number }>;
};
const thrItems = (a: ThrArgs): Array<{ productId: string; threshold: number }> => {
  if (a.changes && (a.productIds || a.threshold !== undefined))
    throw new Error('send either "changes" or "productIds" with "threshold", not both');
  const items =
    a.changes ??
    (a.productIds && a.threshold !== undefined
      ? a.productIds.map(productId => ({ productId, threshold: a.threshold as number }))
      : null);
  if (!items || items.length === 0)
    throw new Error('send "productIds" with "threshold" (or "changes")');
  return items.filter((it, i) => items.findIndex(x => x.productId === it.productId) === i);
};
type ThrState = { products: Array<{ id: string; name: string; threshold: number }> };

const setThreshold = change<ThrArgs>({
  name: 'inventory_set_threshold',
  capabilityId: 'inventory.alerts-thresholds',
  description:
    'Set the low-stock alert threshold (units) on products. Give `productIds` (up to 100) with one `threshold`, or `changes` with a threshold per product.',
  schema: shape<ThrArgs>(
    {
      productIds: f.list(f.id(), { min: 1, max: 100, description: 'Products to change' }),
      threshold: f.int('Alert when stock is at or below this many units', { max: 1_000_000 }),
      changes: f.list(
        f.obj({ productId: f.id(), threshold: f.int(undefined, { max: 1_000_000 }) }, [
          'productId',
          'threshold',
        ]),
        { min: 1, max: 100, description: 'One threshold per product (alternative)' }
      ),
    },
    []
  ),
  undo: 'reversible',
  // inventory.routes.ts PUT /products/:productId/threshold and products POST /bulk-set-low-stock-threshold: authorize('store_admin', 'super_admin', 'staff') + requireFeature('inventory.stock_alerts').
  gate: { roles: ['store_admin', 'staff'], feature: 'inventory.stock_alerts' },
  audit: {
    action: 'product.bulk_low_stock_threshold',
    resourceType: 'product',
    resourceId: a => (thrItems(a).length === 1 ? thrItems(a)[0]!.productId : undefined),
  },
  refs: a => thrItems(a).map(i => productRef(i.productId)),
  state: async (ctx, a) => {
    const ids = uniq(thrItems(a).map(i => i.productId)).sort();
    const products = await mapChunked(ids, async id => {
      const p = (await ProductService.getById(ctx.storeId, id)) as Obj;
      return { id, name: String(p.name ?? ''), threshold: Number(p.lowStockThreshold ?? 0) };
    });
    return { products } satisfies ThrState;
  },
  describe: (_ctx, a, state) => {
    const items = thrItems(a);
    const byId = new Map((state as ThrState).products.map(p => [p.id, p]));
    return {
      summary: pair(
        `هظبط حد التنبيه للمخزون على ${items.length} منتج.`,
        `Set the low-stock threshold on ${items.length} product(s).`
      ),
      rows: items.map(i =>
        row(
          `حد التنبيه «${byId.get(i.productId)!.name}»`,
          `Low-stock threshold of "${byId.get(i.productId)!.name}"`,
          byId.get(i.productId)!.threshold,
          i.threshold
        )
      ),
      affectedCount: items.length,
      restore: {
        changes: items.map(i => ({
          productId: i.productId,
          threshold: byId.get(i.productId)!.threshold,
        })),
      },
    };
  },
  run: async (ctx, a) => {
    const groups = new Map<number, string[]>();
    for (const i of thrItems(a))
      groups.set(i.threshold, [...(groups.get(i.threshold) ?? []), i.productId]);
    for (const [threshold, ids] of groups) {
      if (ids.length === 1) await InventoryService.updateThreshold(ctx.storeId, ids[0]!, threshold);
      else await ProductService.bulkSetLowStockThreshold(ctx.storeId, ids, threshold);
    }
    return { updated: thrItems(a).length };
  },
  inverse: (_a, restore) => ({
    tool: 'inventory_set_threshold',
    args: { changes: (restore as { changes: unknown }).changes },
  }),
});

// ---- reorder_rule_set / reorder_rule_delete --------------------------------------------------------------------------------------------------
type RuleArgs = {
  productId: string;
  variantId?: string;
  minQty?: number;
  reorderQty?: number;
  leadTimeDays?: number;
  safetyStockDays?: number;
  isActive?: boolean;
};
const RULE_KEYS = ['minQty', 'reorderQty', 'leadTimeDays', 'safetyStockDays', 'isActive'] as const;
const RULE_LABELS: Record<(typeof RULE_KEYS)[number], [string, string]> = {
  minQty: ['حد إعادة الطلب', 'Reorder point'],
  reorderQty: ['كمية الطلب', 'Reorder quantity'],
  leadTimeDays: ['مدة التوريد (أيام)', 'Lead time (days)'],
  safetyStockDays: ['مخزون الأمان (أيام)', 'Safety stock (days)'],
  isActive: ['القاعدة شغالة', 'Rule active'],
};
type RuleState = { productName: string; rule: (Obj & { id: string }) | null };
/** One state shape for the set and the delete tool (so the undo of a create, a delete, previews the etag the create left behind). */
const ruleState = async (
  storeId: string,
  a: { productId: string; variantId?: string }
): Promise<RuleState> => {
  const p = (await ProductService.getById(storeId, a.productId)) as Obj; // 404 on a product of another store
  if (a.variantId) {
    const v = (await VariantService.getProductVariants(storeId, a.productId)) as {
      variants: Obj[];
    };
    if (!v.variants.some(x => x.id === a.variantId))
      throw new Error('NOT_FOUND: that variant is not on this product');
  }
  const rules = (await listReorderRules(storeId)) as Obj[];
  const r = rules.find(
    x => x.productId === a.productId && (x.variantId ?? null) === (a.variantId ?? null)
  );
  return {
    productName: String(p.name ?? ''),
    rule: r
      ? { id: String(r.id), ...Object.fromEntries(RULE_KEYS.map(k => [k, r[k] ?? null])) }
      : null,
  };
};
const ruleTarget = (a: RuleArgs) => ({
  productId: a.productId,
  ...(a.variantId ? { variantId: a.variantId } : {}),
});

const setRule = change<RuleArgs>({
  name: 'reorder_rule_set',
  capabilityId: 'inventory.reorder',
  description:
    'Create or update the reorder rule of a product (or one of its variants): the stock level that triggers a reorder, the quantity to order, lead time, safety days, on/off. ' +
    'A new rule needs minQty and reorderQty.',
  schema: shape<RuleArgs>(
    {
      productId: f.id('The product id'),
      variantId: f.id('The variant id, when the rule is for one variant'),
      minQty: f.int('Reorder when stock reaches this many units', { max: 1_000_000 }),
      reorderQty: f.int('Units to order (1 or more)', { min: 1, max: 1_000_000 }),
      leadTimeDays: f.int('Supplier lead time in days', { max: 365 }),
      safetyStockDays: f.int('Safety stock in days', { max: 365 }),
      isActive: f.bool('Whether the rule is on'),
    },
    ['productId']
  ),
  undo: 'reversible',
  // reorder-rules.routes.ts POST/PATCH /:storeId/stock/reorder-rules: authorize('store_admin', 'super_admin') + requireMfaEnrolled (the route also needs an MFA-enrolled owner; runAsMerchant cannot see MFA, see the report).
  gate: { roles: ['store_admin'] },
  audit: {
    action: 'reorder_rule.updated',
    resourceType: 'reorder_rule',
    resourceId: a => a.productId,
  },
  refs: a => [productRef(a.productId)],
  state: (ctx, a) => ruleState(ctx.storeId, a),
  describe: (_ctx, a, state) => {
    const { productName, rule } = state as RuleState;
    const keys = RULE_KEYS.filter(k => a[k] !== undefined);
    if (!rule && (a.minQty === undefined || a.reorderQty === undefined))
      throw new Error('A new reorder rule needs both minQty and reorderQty.');
    if (rule && keys.length === 0)
      throw new Error('reorder_rule_set: nothing to change; send at least one field.');
    return {
      summary: pair(
        rule
          ? `هعدّل قاعدة إعادة الطلب لـ«${productName}».`
          : `هعمل قاعدة إعادة طلب لـ«${productName}».`,
        rule
          ? `Update the reorder rule of "${productName}".`
          : `Create a reorder rule for "${productName}".`
      ),
      rows: keys.map(k =>
        row(RULE_LABELS[k][0], RULE_LABELS[k][1], rule ? (rule[k] ?? null) : null, a[k])
      ),
      affectedCount: 1,
      // an existing rule is restored field by field; a new one is deleted by the inverse (which needs the run result: the rule exists only after apply)
      restore: rule ? Object.fromEntries(RULE_KEYS.map(k => [k, rule[k] ?? null])) : null,
    };
  },
  run: async (ctx, a, state) => {
    const { rule } = state as RuleState;
    if (rule) {
      const patch = Object.fromEntries(
        RULE_KEYS.filter(k => a[k] !== undefined).map(k => [k, a[k]])
      );
      await updateReorderRule(ctx.storeId, rule.id, patch);
      return { ruleId: rule.id, created: false };
    }
    const made = (await createReorderRule(ctx.storeId, {
      productId: a.productId,
      variantId: a.variantId ?? null,
      minQty: a.minQty as number,
      reorderQty: a.reorderQty as number,
      ...(a.leadTimeDays !== undefined ? { leadTimeDays: a.leadTimeDays } : {}),
      ...(a.safetyStockDays !== undefined ? { safetyStockDays: a.safetyStockDays } : {}),
      ...(a.isActive !== undefined ? { isActive: a.isActive } : {}),
    })) as { id: string };
    return { ruleId: made.id, created: true };
  },
  inverse: (a: RuleArgs, restore) =>
    restore
      ? { tool: 'reorder_rule_set', args: { ...ruleTarget(a), ...(restore as Obj) } }
      : { tool: 'reorder_rule_delete', args: ruleTarget(a) },
});

type RuleDelArgs = { productId: string; variantId?: string };
const deleteRule = change<RuleDelArgs>({
  name: 'reorder_rule_delete',
  capabilityId: 'inventory.reorder',
  description: 'Delete the reorder rule of a product (or one of its variants). Cannot be undone.',
  schema: shape<RuleDelArgs>(
    {
      productId: f.id('The product id'),
      variantId: f.id('The variant id, when the rule is for one variant'),
    },
    ['productId']
  ),
  policy: 'confirm',
  deletes: true,
  undo: 'irreversible',
  // reorder-rules.routes.ts DELETE /:storeId/stock/reorder-rules/:id: authorize('store_admin', 'super_admin') + requireMfaEnrolled.
  gate: { roles: ['store_admin'] },
  audit: {
    action: 'reorder_rule.deleted',
    resourceType: 'reorder_rule',
    resourceId: a => a.productId,
  },
  refs: a => [productRef(a.productId)],
  state: (ctx, a) => ruleState(ctx.storeId, a),
  describe: (_ctx, _a, state) => {
    const { productName, rule } = state as RuleState;
    if (!rule) throw new Error('NOT_FOUND: there is no reorder rule for this item.');
    return {
      summary: pair(
        `هحذف قاعدة إعادة الطلب لـ«${productName}».`,
        `Delete the reorder rule of "${productName}".`
      ),
      rows: RULE_KEYS.map(k => row(RULE_LABELS[k][0], RULE_LABELS[k][1], rule[k] ?? null, null)),
      affectedCount: 1,
    };
  },
  run: async (ctx, _a, state) => {
    const { rule } = state as RuleState;
    await deleteReorderRule(ctx.storeId, rule!.id);
    return { deleted: rule!.id };
  },
});

export function inventoryTools(): ToolSpec[] {
  return [adjust, setThreshold, setRule, deleteRule];
}
