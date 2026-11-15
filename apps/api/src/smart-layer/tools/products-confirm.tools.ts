/**
 * Wave 2 (plan 4 C2): confirm-class product tools of the Store assistant: delete one product, and bulk-update up to 200 products. Both go through
 * the same ProductService methods the admin routes call; the engine issues the durable approval bound to the exact card.
 */
import { z } from 'zod/v3';
import type { PreviewRow, ToolSpec } from '@ebda/shared/smart-layer';
import { ProductService } from '../../services/product.service';
import { change, egp, f, pair, row, shape } from './kit';

type Obj = Record<string, unknown>;
const productRef = (id: string) => ({ kind: 'product', id });
const MAX_PRODUCTS = 200;
const SAMPLE = 10;
const MAX_INT4 = 2_147_483_647;

// ---- product_delete --------------------------------------------------------------------------------------------------------------------------
type DelArgs = { productId: string };
const deleteProduct = change<DelArgs>({
  name: 'product_delete',
  capabilityId: 'product.delete',
  description:
    'Delete ONE product (it disappears from the store). Cannot be undone from the assistant; offer product_set_status draft (hide it) first when the merchant only wants it off the store.',
  schema: shape<DelArgs>({ productId: f.id('The product id') }, ['productId']),
  policy: 'confirm',
  deletes: true,
  undo: 'irreversible', // ProductService.delete is a soft delete but no service restores it, so there is nothing to call
  // product.routes.ts DELETE /:id: requirePermission('products:delete') (store_admin only; staff cannot delete).
  gate: { permission: 'products:delete' },
  audit: { action: 'product.deleted', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: async (ctx, a) => {
    const p = (await ProductService.getById(ctx.storeId, a.productId)) as Obj;
    return {
      id: p.id,
      name: p.name ?? null,
      nameAr: p.nameAr ?? null,
      price: p.price ?? null,
      stock: p.totalInventory ?? p.inventory ?? null,
      status: p.status ?? null,
    };
  },
  describe: (_ctx, _a, state) => {
    const s = state as Obj;
    const nm = String(s.nameAr ?? s.name ?? '');
    return {
      summary: pair(
        `هحذف المنتج «${nm}» من المتجر. مينفعش أرجّعه من المساعد. لو عايز بس تخفيه، خلّيه مسودة.`,
        `Delete "${s.name}" from the store. It cannot be restored from the assistant; set it to draft to only hide it.`
      ),
      rows: [
        row('المنتج', 'Product', s.name, null),
        row('السعر (جنيه)', 'Price (EGP)', egp(s.price as number | null), null),
        row('المخزون', 'Stock', s.stock, null),
        row('الحالة', 'Status', s.status, null),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    await ProductService.delete(ctx.storeId, a.productId);
    return { deleted: a.productId };
  },
});

// ---- products_bulk_update --------------------------------------------------------------------------------------------------------------------
type Flags = {
  status?: 'draft' | 'active' | 'archived';
  isFeatured?: boolean;
  isNew?: boolean;
  isBestSeller?: boolean;
};
type Exact = Flags & { productId: string; price?: number };
type BulkArgs = Flags & {
  productIds?: string[];
  categoryName?: string;
  pricePercent?: number;
  exact?: Exact[];
};
const FLAG_KEYS = ['status', 'isFeatured', 'isNew', 'isBestSeller'] as const;
const LABELS: Record<string, [string, string]> = {
  price: ['السعر (جنيه)', 'Price (EGP)'],
  status: ['الحالة', 'Status'],
  isFeatured: ['منتج مميز', 'Featured'],
  isNew: ['شارة جديد', 'New badge'],
  isBestSeller: ['الأكثر مبيعاً', 'Best seller'],
};
type Item = {
  id: string;
  name: string;
  price: number;
  status: string;
  isFeatured: boolean;
  isNew: boolean;
  isBestSeller: boolean;
  priceable: boolean;
};
type BulkState = { items: Item[] };

const modeOf = (a: BulkArgs) => {
  const hasFields = a.pricePercent !== undefined || FLAG_KEYS.some(k => a[k] !== undefined);
  const hasTarget = !!a.productIds?.length || !!a.categoryName;
  if (a.exact) {
    if (hasFields || hasTarget)
      throw new Error('"exact" stands alone: do not combine it with a target or fields');
    return 'exact' as const;
  }
  if (!hasTarget) throw new Error('name the products: productIds (up to 200) or categoryName');
  if (a.productIds?.length && a.categoryName)
    throw new Error('send productIds or categoryName, not both');
  if (!hasFields)
    throw new Error(
      'send at least one change: pricePercent, status, isFeatured, isNew or isBestSeller'
    );
  return 'fields' as const;
};
const afterPrice = (p: Item, pct: number) =>
  Math.min(MAX_INT4, Math.max(0, Math.round(p.price * (1 + pct / 100))));
/** What each product ends up with, computed with the service's own rules (variant and gold-rate products keep their price). */
function plan(a: BulkArgs, items: Item[]) {
  const mode = modeOf(a);
  const byId = new Map(items.map(i => [i.id, i]));
  const exact = new Map((a.exact ?? []).map(e => [e.productId, e]));
  return items.map(p => {
    const set: Obj = {};
    const src: Obj = mode === 'exact' ? (exact.get(p.id) ?? {}) : a;
    if (mode === 'exact') {
      if (typeof src.price === 'number' && p.priceable)
        set.price = Math.round((src.price as number) * 100);
    } else if (a.pricePercent !== undefined && p.priceable)
      set.price = afterPrice(p, a.pricePercent);
    for (const k of FLAG_KEYS) if (src[k] !== undefined) set[k] = src[k];
    const changed = Object.fromEntries(
      Object.entries(set).filter(([k, v]) => (p as unknown as Obj)[k] !== v)
    );
    return { p: byId.get(p.id)!, set, changed };
  });
}

const resolveItems = async (storeId: string, a: BulkArgs): Promise<BulkState> => {
  const mode = modeOf(a);
  let ids: string[] | undefined;
  let categoryId: string | undefined;
  if (mode === 'exact') {
    ids = a.exact!.map(e => e.productId);
  } else if (a.productIds?.length) {
    ids = a.productIds;
  } else {
    const wanted = a.categoryName!.trim().toLowerCase();
    const cats = (await ProductService.getCategories(storeId)) as Array<Obj>;
    const hits = cats.filter(
      c =>
        !String(c.id).startsWith('virtual:') &&
        [c.name, c.nameAr].some(n => typeof n === 'string' && n.trim().toLowerCase() === wanted)
    );
    if (hits.length !== 1)
      throw new Error(
        hits.length
          ? 'AMBIGUOUS_CATEGORY: more than one category has that name'
          : 'CATEGORY_NOT_FOUND: no category with that name in this store'
      );
    categoryId = String(hits[0]!.id);
  }
  let rows: Obj[];
  if (categoryId) {
    const r = (await ProductService.list(storeId, {
      category: categoryId,
      limit: MAX_PRODUCTS + 1,
    })) as { products: Obj[]; meta: { total: number } };
    if (r.meta.total > MAX_PRODUCTS)
      throw new Error(
        `TOO_MANY_PRODUCTS: ${r.meta.total} products match; the limit is ${MAX_PRODUCTS} per change. Narrow it down.`
      );
    rows = r.products;
  } else {
    if (ids!.length > MAX_PRODUCTS)
      throw new Error(`TOO_MANY_PRODUCTS: the limit is ${MAX_PRODUCTS} per change.`);
    const uniq = [...new Set(ids!)];
    rows = [];
    for (let i = 0; i < uniq.length; i += 10)
      rows.push(
        ...(await Promise.all(
          uniq.slice(i, i + 10).map(id => ProductService.getById(storeId, id) as Promise<Obj>)
        ))
      ); // 404 on a product of another store
  }
  const items: Item[] = rows
    .map(p => ({
      id: String(p.id),
      name: String(p.name ?? ''),
      price: Number(p.price ?? 0),
      status: String(p.status ?? ''),
      isFeatured: !!p.featured,
      isNew: !!p.isNew,
      isBestSeller: !!p.isBestSeller,
      priceable:
        !(
          Number(
            (p as { variantCount?: number }).variantCount ??
              (p.variants as unknown[] | undefined)?.length ??
              0
          ) > 0
        ) && p.pricingMode !== 'gold_rate',
    }))
    .sort((x, y) => x.id.localeCompare(y.id));
  if (items.length === 0) throw new Error('NO_PRODUCTS: nothing matches');
  return { items };
};

const bulkUpdate = change<BulkArgs>({
  name: 'products_bulk_update',
  capabilityId: 'product.bulk-update',
  description:
    'Change many products at once (up to 200): raise or lower prices by a percentage (pricePercent, e.g. -10 for 10% off), or set status / featured / new / best-seller flags. ' +
    'Target them with productIds or with categoryName. Variant products and gold-rate products keep their price. Always shows a count and a sample first and needs approval.',
  schema: shape<BulkArgs>(
    {
      productIds: f.list(f.id(), { min: 1, max: MAX_PRODUCTS, description: 'Products to change' }),
      categoryName: f.str(
        'Name of a category (Arabic or English); every product in it is changed',
        { max: 120 }
      ),
      pricePercent: {
        z: z.number().min(-90).max(200),
        js: {
          type: 'number',
          minimum: -90,
          maximum: 200,
          description: 'Price change in percent, e.g. -10 for 10% off, 5 for 5% up',
        },
      },
      status: f.enum(['draft', 'active', 'archived'], 'New status for all of them'),
      isFeatured: f.bool('Featured flag'),
      isNew: f.bool('New badge'),
      isBestSeller: f.bool('Best seller flag'),
      exact: f.list(
        f.obj(
          {
            productId: f.id(),
            price: f.num('Exact price in EGP'),
            status: f.enum(['draft', 'active', 'archived']),
            isFeatured: f.bool(),
            isNew: f.bool(),
            isBestSeller: f.bool(),
          },
          ['productId']
        ),
        {
          min: 1,
          max: MAX_PRODUCTS,
          description: 'Exact per-product values (used by undo). Stands alone.',
        }
      ),
    },
    []
  ),
  policy: 'confirm',
  undo: 'compensating',
  // product.routes.ts POST /bulk-update: authorize('store_admin', 'super_admin'); the same ProductService.bulkUpdate (the plan gate bulk_operations is in the registry, not on the route).
  gate: { roles: ['store_admin'] },
  audit: { action: 'product.bulk_update', resourceType: 'store' },
  refs: a => [...(a.productIds ?? []), ...(a.exact ?? []).map(e => e.productId)].map(productRef),
  state: (ctx, a) => resolveItems(ctx.storeId, a),
  describe: (_ctx, a, state) => {
    const st = state as BulkState;
    const planned = plan(a, st.items);
    const touched = planned.filter(x => Object.keys(x.changed).length > 0);
    if (a.pricePercent !== undefined && (a.pricePercent < -90 || a.pricePercent > 200))
      throw new Error('pricePercent must be between -90 and 200');
    const skipped =
      a.exact === undefined && a.pricePercent !== undefined
        ? st.items.filter(i => !i.priceable).length
        : 0;
    const rows: PreviewRow[] = [
      row('عدد المنتجات اللي هتتغيّر', 'Products that change', st.items.length, touched.length),
    ];
    if (skipped)
      rows.push(
        row(
          'منتجات بنسخ أو بسعر ذهب (سعرها مش هيتغيّر)',
          'Variant or gold-rate products (price unchanged)',
          skipped,
          skipped
        )
      );
    for (const x of touched.slice(0, SAMPLE)) {
      for (const [k, v] of Object.entries(x.changed)) {
        const [ar, en] = LABELS[k] ?? [k, k];
        const cur = (x.p as unknown as Obj)[k];
        rows.push(
          row(
            `${ar} · ${x.p.name}`,
            `${en} · ${x.p.name}`,
            k === 'price' ? egp(cur as number) : cur,
            k === 'price' ? egp(v as number) : v
          )
        );
      }
    }
    if (touched.length > SAMPLE)
      rows.push(
        row(
          'وفيه منتجات تانية بنفس التغيير',
          'More products change the same way',
          null,
          touched.length - SAMPLE
        )
      );
    const restoreKeys = (x: (typeof planned)[number]) => Object.keys(x.set);
    const restore = {
      exact: planned.map(x => ({
        productId: x.p.id,
        ...Object.fromEntries(
          restoreKeys(x).map(k => [k, k === 'price' ? x.p.price / 100 : (x.p as unknown as Obj)[k]])
        ),
      })),
    };
    const pct = a.pricePercent;
    return {
      summary: pair(
        `هغيّر ${touched.length} منتج${pct !== undefined ? ` (السعر ${pct > 0 ? '+' : ''}${pct}%)` : ''}. اللي هيتغيّر بالظبط تحت.`,
        `Change ${touched.length} product(s)${pct !== undefined ? ` (price ${pct > 0 ? '+' : ''}${pct}%)` : ''}. Exact changes below.`
      ),
      rows,
      affectedCount: touched.length,
      restore,
      ...(touched.some(x => 'price' in x.changed) ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a, state) => {
    const st = state as BulkState;
    const planned = plan(a, st.items);
    const mode = modeOf(a);
    if (mode === 'fields') {
      const fields: Obj = {};
      for (const k of FLAG_KEYS) if (a[k] !== undefined) fields[k] = a[k];
      if (a.pricePercent !== undefined) fields.price = { mode: 'adjustPct', value: a.pricePercent };
      return ProductService.bulkUpdate(
        ctx.storeId,
        st.items.map(i => i.id),
        fields as never
      );
    }
    // exact (undo): products that already hold the values are skipped; the rest go in one call per distinct value set
    const groups = new Map<string, { ids: string[]; fields: Obj }>();
    for (const x of planned) {
      if (Object.keys(x.changed).length === 0) continue;
      const fields: Obj = { ...x.changed };
      if ('price' in fields) fields.price = { mode: 'set', value: fields.price };
      const key = JSON.stringify(fields);
      const g = groups.get(key) ?? { ids: [], fields };
      g.ids.push(x.p.id);
      groups.set(key, g);
    }
    let updated = 0;
    for (const g of groups.values())
      updated += (await ProductService.bulkUpdate(ctx.storeId, g.ids, g.fields as never)).updated;
    return { updated };
  },
  inverse: (_a, restore) => ({ tool: 'products_bulk_update', args: restore }),
});

export function productsConfirmTools(): ToolSpec[] {
  return [deleteProduct, bulkUpdate];
}
