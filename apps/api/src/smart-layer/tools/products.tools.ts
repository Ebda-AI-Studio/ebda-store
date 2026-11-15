/**
 * Wave 1 (plan 4 B6): product write tools of the Store assistant. Each is one `change()` from ./kit. A tool's gate is the SAME permission /
 * role list the admin route demands (cited per tool), its `run` calls the SAME service method the route (or the Merchant MCP write tool)
 * calls, money args are EGP decimals converted with Math.round(x * 100) (the services hold integer piasters), and the inverse restores the
 * BEFORE values captured in the preview.
 */
import { type PreviewRow, type ToolSpec, type TurnCtx } from '@ebda/shared/smart-layer';
import { ProductService } from '../../services/product.service';
import { VariantService } from '../../services/variant.service';
import {
  createProductFaq,
  deleteProductFaq,
  listProductFaqs,
} from '../../services/product-faq.service';
import {
  applyProductTags,
  getProductTags,
  type TagMode,
} from '../../services/product-tags.service';
import { createProductSchemaChecked, updateProductSchema } from '../../routes/product.routes';
import { change, egp, f, pair, row, shape, type Described } from './kit';

type Obj = Record<string, unknown>;
const CHUNK = 10;
/** Maps `fn` over `xs` ten at a time (store-scoped reads; keeps a 100-product card from opening 100 connections at once). */
async function mapChunked<T, R>(xs: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += CHUNK)
    out.push(...(await Promise.all(xs.slice(i, i + CHUNK).map(fn))));
  return out;
}
const piasters = (egpValue: number) => Math.round(egpValue * 100);
const fromPiasters = (v: unknown): number | null => (typeof v === 'number' ? v / 100 : null);
const productRef = (id: string) => ({ kind: 'product', id });
const uniq = <T>(xs: T[]) => [...new Set(xs)];

// ---- product_update_fields --------------------------------------------------------------------------------------------------------------------
type FieldDef = {
  col: string;
  label: [string, string];
  field: ReturnType<typeof f.str>;
  money?: boolean;
};
const nullableText = (d: string, max: number) => f.nullable(f.text(d, { max }));
const EDIT: Record<string, FieldDef> = {
  name: {
    col: 'name',
    label: ['الاسم (إنجليزي)', 'Name'],
    field: f.str('Product name (the English field)', { max: 255 }),
  },
  nameAr: {
    col: 'nameAr',
    label: ['الاسم بالعربي', 'Arabic name'],
    field: nullableText('Arabic product name; null clears', 255),
  },
  description: {
    col: 'description',
    label: ['الوصف', 'Description'],
    field: nullableText('Description; null clears', 5000),
  },
  descriptionAr: {
    col: 'descriptionAr',
    label: ['الوصف بالعربي', 'Arabic description'],
    field: nullableText('Arabic description; null clears', 5000),
  },
  excerpt: {
    col: 'excerpt',
    label: ['نبذة قصيرة', 'Short blurb'],
    field: nullableText('One or two sentence blurb; null clears', 300),
  },
  excerptAr: {
    col: 'excerptAr',
    label: ['النبذة بالعربي', 'Arabic short blurb'],
    field: nullableText('Arabic blurb; null clears', 300),
  },
  price: {
    col: 'price',
    label: ['السعر (جنيه)', 'Price (EGP)'],
    field: f.num('Price in EGP (a decimal number such as 249.5)'),
    money: true,
  },
  compareAtPrice: {
    col: 'compareAtPrice',
    label: ['السعر قبل الخصم (جنيه)', 'Compare-at price (EGP)'],
    field: f.nullable(f.num('Compare-at (before sale) price in EGP; null clears')),
    money: true,
  },
  sku: {
    col: 'sku',
    label: ['كود المنتج SKU', 'SKU'],
    field: nullableText('SKU; null clears', 100),
  },
  isFeatured: {
    col: 'featured',
    label: ['منتج مميز', 'Featured'],
    field: f.bool('Show as featured'),
  },
  isNew: { col: 'isNew', label: ['شارة جديد', 'New badge'], field: f.bool('Show the New badge') },
  isBestSeller: {
    col: 'isBestSeller',
    label: ['الأكثر مبيعاً', 'Best seller'],
    field: f.bool('Flag as best seller'),
  },
  badgeLabel: {
    col: 'badgeLabel',
    label: ['كلمة الشارة', 'Badge label'],
    field: nullableText('Short badge text (max 32); null clears', 32),
  },
  badgeLabelAr: {
    col: 'badgeLabelAr',
    label: ['كلمة الشارة بالعربي', 'Arabic badge label'],
    field: nullableText('Arabic badge text (max 32); null clears', 32),
  },
  leadTimeDays: {
    col: 'leadTimeDays',
    label: ['مدة التجهيز (أيام)', 'Lead time (days)'],
    field: f.nullable(f.int('Made-to-order days 0-60; null = ready to ship', { max: 60 })),
  },
  searchTerms: {
    col: 'searchTerms',
    label: ['كلمات بحث إضافية', 'Extra search words'],
    field: nullableText('Extra words shoppers type, comma separated; null clears', 500),
  },
  metaTitle: {
    col: 'metaTitle',
    label: ['عنوان جوجل', 'SEO title'],
    field: nullableText('SEO title; null clears', 180),
  },
  metaTitleAr: {
    col: 'metaTitleAr',
    label: ['عنوان جوجل بالعربي', 'Arabic SEO title'],
    field: nullableText('Arabic SEO title; null clears', 180),
  },
  metaDescription: {
    col: 'metaDescription',
    label: ['وصف جوجل', 'SEO description'],
    field: nullableText('SEO description; null clears', 400),
  },
  metaDescriptionAr: {
    col: 'metaDescriptionAr',
    label: ['وصف جوجل بالعربي', 'Arabic SEO description'],
    field: nullableText('Arabic SEO description; null clears', 400),
  },
};
type UpdateArgs = { productId: string } & Obj;
const touchedKeys = (a: UpdateArgs) => Object.keys(EDIT).filter(k => a[k] !== undefined);
const toChanges = (a: UpdateArgs): Obj =>
  Object.fromEntries(
    touchedKeys(a).map(k => [
      k,
      EDIT[k]!.money && typeof a[k] === 'number' ? piasters(a[k] as number) : a[k],
    ])
  );
const showMoney = (k: string, v: unknown) =>
  EDIT[k]!.money ? egp(v as number | null) : (v ?? null);

const updateFields = change<UpdateArgs>({
  name: 'product_update_fields',
  capabilityId: 'product.edit',
  description:
    'Edit text, flags, SKU or price of ONE product. Send only the fields to change. Prices are in EGP (a decimal such as 249.5), not piasters. ' +
    'Pass null to clear an optional field. Stock is not here (use inventory_adjust).',
  schema: shape<UpdateArgs>(
    {
      productId: f.id('The product id'),
      ...Object.fromEntries(Object.entries(EDIT).map(([k, d]) => [k, d.field])),
    },
    ['productId']
  ),
  undo: 'reversible',
  // product.routes.ts PUT /:id: requirePermission('products:write'); the same ProductService.update the Merchant MCP admin_update_product calls.
  gate: { permission: 'products:write' },
  audit: { action: 'product.updated', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: async (ctx, a) => {
    const p = (await ProductService.getById(ctx.storeId, a.productId)) as Obj;
    return Object.fromEntries(
      ['id', ...Object.values(EDIT).map(d => d.col)].map(k => [k, p[k] ?? null])
    );
  },
  describe: (_ctx, a, state) => {
    const before = state as Obj;
    const keys = touchedKeys(a);
    if (keys.length === 0)
      throw new Error('product_update_fields: nothing to change; send at least one field.');
    updateProductSchema.parse(toChanges(a)); // the route's own validation: the same normalisation and limits
    const restore: Obj = {};
    for (const k of keys)
      restore[k] = EDIT[k]!.money
        ? fromPiasters(before[EDIT[k]!.col])
        : (before[EDIT[k]!.col] ?? null);
    // the name pair is resolved together by the service, so a restore of one restores both
    if ('name' in restore || 'nameAr' in restore) {
      restore.name = before.name ?? null;
      restore.nameAr = before.nameAr ?? null;
    }
    const rows: PreviewRow[] = keys.map(k =>
      row(
        EDIT[k]!.label[0],
        EDIT[k]!.label[1],
        showMoney(k, before[EDIT[k]!.col]),
        EDIT[k]!.money ? a[k] : a[k]
      )
    );
    const nm = String(before.name ?? '');
    return {
      summary: pair(
        `هعدّل ${keys.length} حقل في المنتج «${nm}».`,
        `Update ${keys.length} field(s) on "${nm}".`
      ),
      rows,
      affectedCount: 1,
      restore,
      ...(keys.includes('price') || keys.includes('compareAtPrice') ? { changesPrice: true } : {}),
    } satisfies Described;
  },
  run: (ctx, a) =>
    ProductService.update(
      ctx.storeId,
      a.productId,
      updateProductSchema.parse(toChanges(a)) as never
    ),
  inverse: (a, restore) => ({
    tool: 'product_update_fields',
    args: { productId: a.productId, ...(restore as Obj) },
  }),
});

// ---- product_set_status ----------------------------------------------------------------------------------------------------------------------
type StatusArgs = { productId: string; status: 'draft' | 'active' | 'archived' };
const setStatus = change<StatusArgs>({
  name: 'product_set_status',
  capabilityId: 'product.edit',
  description: 'Set ONE product to draft (hidden), active (live in the store) or archived.',
  schema: shape<StatusArgs>(
    {
      productId: f.id('The product id'),
      status: f.enum(['draft', 'active', 'archived'], 'New status'),
    },
    ['productId', 'status']
  ),
  undo: 'reversible',
  // product.routes.ts PUT /:id (status is one of its fields): products:write.
  gate: { permission: 'products:write' },
  audit: { action: 'product.updated', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: async (ctx, a) => {
    const p = (await ProductService.getById(ctx.storeId, a.productId)) as Obj;
    return { id: p.id, name: p.name ?? null, status: p.status ?? null };
  },
  describe: (_ctx, a, state) => {
    const s = state as Obj;
    return {
      summary: pair(
        `هغيّر حالة المنتج «${s.name}» إلى ${a.status}.`,
        `Set "${s.name}" to ${a.status}.`
      ),
      rows: [row('الحالة', 'Status', s.status, a.status)],
      affectedCount: 1,
      restore: { status: s.status },
    };
  },
  run: (ctx, a) => ProductService.update(ctx.storeId, a.productId, { status: a.status } as never),
  inverse: (a, restore) => ({
    tool: 'product_set_status',
    args: { productId: a.productId, status: (restore as Obj).status },
  }),
});

// ---- shared: change lists over products (categories, tags) -----------------------------------------------------------------------------------
/** A tool takes `productIds` + one value list (the model's way) or `changes` (one list per product; the inverse's way). Never both. */
function expandItems<V extends string>(
  a: { productIds?: string[]; changes?: Array<Record<string, unknown>> } & Obj,
  valueKey: string,
  common: string
): Array<{ productId: string; values: V[] }> {
  const many = a.changes;
  const ids = a.productIds;
  const vals = a[common] as V[] | undefined;
  if (many && (ids || vals))
    throw new Error(`send either "changes" or "productIds" with "${common}", not both`);
  const items = many
    ? many.map(c => ({ productId: String(c.productId), values: (c[valueKey] as V[]) ?? [] }))
    : ids && vals
      ? ids.map(productId => ({ productId, values: vals }))
      : null;
  if (!items || items.length === 0)
    throw new Error(`send "productIds" with "${common}" (or "changes")`);
  return items.filter((it, i) => items.findIndex(x => x.productId === it.productId) === i);
}

// ---- product_set_categories ------------------------------------------------------------------------------------------------------------------
type CatArgs = {
  mode: 'add' | 'set';
  productIds?: string[];
  categoryIds?: string[];
  changes?: Array<{ productId: string; categoryIds: string[] }>;
};
const catItems = (a: CatArgs) => expandItems<string>(a as never, 'categoryIds', 'categoryIds');
type CatState = {
  products: Array<{ id: string; name: string; cats: Array<{ id: string; name: string }> }>;
};
const afterCats = (mode: 'add' | 'set', before: string[], wanted: string[]) =>
  mode === 'add' ? uniq([...before, ...wanted]) : uniq(wanted);

const setCategories = change<CatArgs>({
  name: 'product_set_categories',
  capabilityId: 'product.categories',
  description:
    'Put products into categories. mode "add" keeps their current categories and adds the given ones; mode "set" makes the given list their only categories. ' +
    'Give `productIds` (up to 100) with `categoryIds`, or `changes` with a category list per product. Categories are looked up in this store only.',
  schema: shape<CatArgs>(
    {
      mode: f.enum(['add', 'set'], 'add keeps current categories, set replaces them'),
      productIds: f.list(f.id(), { min: 1, max: 100, description: 'Products to change' }),
      categoryIds: f.list(f.id(), { max: 20, description: 'Category ids to add or set' }),
      changes: f.list(
        f.obj({ productId: f.id(), categoryIds: f.list(f.id(), { max: 20 }) }, [
          'productId',
          'categoryIds',
        ]),
        {
          min: 1,
          max: 100,
          description: 'One category list per product (alternative to productIds + categoryIds)',
        }
      ),
    },
    ['mode']
  ),
  undo: 'reversible',
  // product.routes.ts PUT /:id carries `categories` (a replace): products:write. The same ProductService.update, which 404s a foreign category.
  gate: { permission: 'products:write' },
  audit: {
    action: 'product.updated',
    resourceType: 'product',
    resourceId: a => (catItems(a).length === 1 ? catItems(a)[0]!.productId : undefined),
  },
  refs: a => catItems(a).map(i => productRef(i.productId)),
  state: async (ctx, a) => {
    const ids = uniq(catItems(a).map(i => i.productId)).sort();
    const products = await mapChunked(ids, async id => {
      const p = (await ProductService.getById(ctx.storeId, id)) as {
        id: string;
        name: string;
        categories?: Array<{ categoryId: string; category?: { name?: string } }>;
      };
      return {
        id: p.id,
        name: p.name,
        cats: (p.categories ?? [])
          .map(c => ({ id: c.categoryId, name: c.category?.name ?? c.categoryId }))
          .sort((x, y) => x.id.localeCompare(y.id)),
      };
    });
    return { products } satisfies CatState;
  },
  describe: async (ctx, a, state) => {
    const items = catItems(a);
    const named = await ProductService.getCategoriesByIds(
      ctx.storeId,
      uniq(items.flatMap(i => i.values))
    ); // 404 on a foreign category
    const names = new Map<string, string>(named.map(c => [c.id, c.name]));
    const byId = new Map((state as CatState).products.map(p => [p.id, p]));
    for (const p of byId.values()) for (const c of p.cats) names.set(c.id, c.name);
    const label = (ids: string[]) => ids.map(id => names.get(id) ?? id).join('، ');
    const rows = items.map(i => {
      const p = byId.get(i.productId)!;
      const before = p.cats.map(c => c.id);
      return row(
        `تصنيفات «${p.name}»`,
        `Categories of "${p.name}"`,
        label(before),
        label(afterCats(a.mode, before, i.values))
      );
    });
    return {
      summary: pair(
        `هضيف/أظبط التصنيفات على ${items.length} منتج.`,
        `${a.mode === 'add' ? 'Add' : 'Set'} categories on ${items.length} product(s).`
      ),
      rows,
      affectedCount: items.length,
      restore: {
        changes: items.map(i => ({
          productId: i.productId,
          categoryIds: byId.get(i.productId)!.cats.map(c => c.id),
        })),
      },
    };
  },
  run: async (ctx, a, state) => {
    const items = catItems(a);
    await ProductService.getCategoriesByIds(ctx.storeId, uniq(items.flatMap(i => i.values))); // nothing is written when any category is foreign
    const byId = new Map((state as CatState).products.map(p => [p.id, p]));
    let updated = 0;
    for (const i of items) {
      const before = byId.get(i.productId)!.cats.map(c => c.id);
      const next = afterCats(a.mode, before, i.values);
      if (next.length === before.length && next.every(id => before.includes(id))) continue;
      await ProductService.update(ctx.storeId, i.productId, { categories: next } as never);
      updated++;
    }
    return { updated };
  },
  inverse: (_a, restore) => ({
    tool: 'product_set_categories',
    args: { mode: 'set', changes: (restore as { changes: unknown }).changes },
  }),
});

// ---- product_set_tags ------------------------------------------------------------------------------------------------------------------------
type TagArgs = {
  mode: TagMode;
  productIds?: string[];
  tags?: string[];
  changes?: Array<{ productId: string; tags: string[] }>;
};
const tagItems = (a: TagArgs) =>
  expandItems<string>(a as never, 'tags', 'tags').map(i => ({
    productId: i.productId,
    tags: i.values,
  }));
type TagState = { products: Array<{ id: string; name: string; tags: string[] }> };
const afterTags = (mode: TagMode, before: string[], wanted: string[]) => {
  const w = new Set(wanted.map(t => t.toLowerCase()));
  if (mode === 'set') return uniq(wanted);
  if (mode === 'add')
    return [
      ...before,
      ...wanted.filter(t => !before.some(b => b.toLowerCase() === t.toLowerCase())),
    ];
  return before.filter(b => !w.has(b.toLowerCase()));
};

const setTags = change<TagArgs>({
  name: 'product_set_tags',
  capabilityId: 'product.tags',
  description:
    'Add, remove or replace tags (the filter chips on the storefront) on products. Give `productIds` (up to 100) with `tags` (names), or `changes` with a tag list per product. ' +
    'New tag names are created; existing ones are matched ignoring case.',
  schema: shape<TagArgs>(
    {
      mode: f.enum(['add', 'remove', 'set'], 'add, remove, or set (replace) the tags'),
      productIds: f.list(f.id(), { min: 1, max: 100, description: 'Products to change' }),
      tags: f.list(f.str('Tag name', { max: 80 }), { max: 10, description: 'Tag names' }),
      changes: f.list(
        f.obj({ productId: f.id(), tags: f.list(f.str(undefined, { max: 80 }), { max: 50 }) }, [
          'productId',
          'tags',
        ]),
        {
          min: 1,
          max: 100,
          description: 'One tag list per product (alternative to productIds + tags)',
        }
      ),
    },
    ['mode']
  ),
  undo: 'reversible',
  // tag.routes.ts (the only tag admin routes): authorize('store_admin', 'super_admin'); products get tags through the import / AI sweep, whose writes this mirrors.
  gate: { roles: ['store_admin'] },
  audit: {
    action: 'product.tags_changed',
    resourceType: 'product',
    resourceId: a => (tagItems(a).length === 1 ? tagItems(a)[0]!.productId : undefined),
  },
  refs: a => tagItems(a).map(i => productRef(i.productId)),
  state: async (ctx, a) => {
    const ids = uniq(tagItems(a).map(i => i.productId)).sort();
    const cur = await getProductTags(ctx.storeId, ids); // 404 on a product of another store
    return {
      products: ids.map(id => ({ id, name: cur[id]!.name, tags: cur[id]!.tags })),
    } satisfies TagState;
  },
  describe: (_ctx, a, state) => {
    const items = tagItems(a);
    const byId = new Map((state as TagState).products.map(p => [p.id, p]));
    return {
      summary: pair(
        `هعدّل التاجات على ${items.length} منتج.`,
        `${a.mode === 'add' ? 'Add tags to' : a.mode === 'remove' ? 'Remove tags from' : 'Set tags on'} ${items.length} product(s).`
      ),
      rows: items.map(i => {
        const p = byId.get(i.productId)!;
        return row(
          `تاجات «${p.name}»`,
          `Tags of "${p.name}"`,
          p.tags.join('، '),
          afterTags(a.mode, p.tags, i.tags).join('، ')
        );
      }),
      affectedCount: items.length,
      restore: {
        changes: items.map(i => ({ productId: i.productId, tags: byId.get(i.productId)!.tags })),
      },
    };
  },
  run: (ctx, a) => applyProductTags(ctx.storeId, tagItems(a), a.mode),
  inverse: (_a, restore) => ({
    tool: 'product_set_tags',
    args: { mode: 'set', changes: (restore as { changes: unknown }).changes },
  }),
});

// ---- product_add_faq / product_delete_faq -----------------------------------------------------------------------------------------------------
type FaqArgs = {
  productId: string;
  question: string;
  answer: string;
  questionAr?: string;
  answerAr?: string;
};
type FaqRow = {
  id: string;
  question: string;
  answer: string;
  questionAr: string | null;
  answerAr: string | null;
};
/** One state shape for the add and the delete tool, so the etag after an add equals the one the undo (a delete) previews. */
const faqState = async (ctx: TurnCtx, productId: string) => {
  const rows = (await listProductFaqs(ctx.storeId, productId)) as Array<Obj>;
  return {
    productId,
    faqs: rows.map(r => ({
      id: String(r.id),
      question: String(r.question),
      answer: String(r.answer),
      questionAr: (r.questionAr as string) ?? null,
      answerAr: (r.answerAr as string) ?? null,
    })),
  };
};
const addFaq = change<FaqArgs>({
  name: 'product_add_faq',
  capabilityId: 'product.faqs',
  description: 'Add one question and answer to a product page (FAQ). Arabic twins are optional.',
  schema: shape<FaqArgs>(
    {
      productId: f.id('The product id'),
      question: f.str('Question', { max: 500 }),
      answer: f.str('Answer', { max: 5000 }),
      questionAr: f.str('Arabic question', { max: 500 }),
      answerAr: f.str('Arabic answer', { max: 5000 }),
    },
    ['productId', 'question', 'answer']
  ),
  undo: 'compensating',
  // product.routes.ts POST /:id/faqs: authorize('store_admin', 'super_admin', 'staff').
  gate: { roles: ['store_admin', 'staff'] },
  audit: { action: 'product.faq_created', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: (ctx, a) => faqState(ctx, a.productId),
  describe: (_ctx, a) => ({
    summary: pair(
      'هضيف سؤال وإجابة على صفحة المنتج.',
      'Add a question and answer to the product page.'
    ),
    rows: [
      row('السؤال', 'Question', null, a.question),
      row('الإجابة', 'Answer', null, a.answer),
      ...(a.questionAr ? [row('السؤال بالعربي', 'Arabic question', null, a.questionAr)] : []),
      ...(a.answerAr ? [row('الإجابة بالعربي', 'Arabic answer', null, a.answerAr)] : []),
    ],
    affectedCount: 1,
    restore: null,
  }),
  run: async (ctx, a) => {
    const faq = (await createProductFaq(ctx.storeId, a.productId, {
      question: a.question,
      answer: a.answer,
      questionAr: a.questionAr ?? null,
      answerAr: a.answerAr ?? null,
    })) as { id: string };
    return { faqId: faq.id };
  },
  inverse: (a: FaqArgs, _restore, result) => {
    const faqId = (result as { faqId?: string } | undefined)?.faqId;
    return faqId ? { tool: 'product_delete_faq', args: { productId: a.productId, faqId } } : null;
  },
});

type DelFaqArgs = { productId: string; faqId: string };
const deleteFaq = change<DelFaqArgs>({
  name: 'product_delete_faq',
  capabilityId: 'product.faqs',
  description: 'Delete one FAQ from a product page. Cannot be undone.',
  schema: shape<DelFaqArgs>({ productId: f.id('The product id'), faqId: f.id('The FAQ id') }, [
    'productId',
    'faqId',
  ]),
  policy: 'confirm',
  deletes: true,
  undo: 'irreversible',
  // product.routes.ts DELETE /:id/faqs/:faqId: authorize('store_admin', 'super_admin', 'staff').
  gate: { roles: ['store_admin', 'staff'] },
  audit: { action: 'product.faq_deleted', resourceType: 'product', resourceId: a => a.productId },
  refs: a => [productRef(a.productId)],
  state: (ctx, a) => faqState(ctx, a.productId),
  describe: (_ctx, a, state) => {
    const faq = (state as { faqs: FaqRow[] }).faqs.find(x => x.id === a.faqId);
    if (!faq) throw new Error('NOT_FOUND: that FAQ is not on this product');
    return {
      summary: pair('هحذف سؤال من صفحة المنتج.', 'Delete a question from the product page.'),
      rows: [
        row('السؤال', 'Question', faq.question, null),
        row('الإجابة', 'Answer', faq.answer, null),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    await deleteProductFaq(ctx.storeId, a.productId, a.faqId);
    return { deleted: a.faqId };
  },
});

// ---- variant_update --------------------------------------------------------------------------------------------------------------------------
type VarArgs = {
  productId: string;
  variantId: string;
  price?: number | null;
  compareAtPrice?: number | null;
  sku?: string | null;
  isActive?: boolean;
};
const VAR_FIELDS: Record<string, { label: [string, string]; money?: boolean }> = {
  price: { label: ['سعر النسخة (جنيه)', 'Variant price (EGP)'], money: true },
  compareAtPrice: { label: ['السعر قبل الخصم (جنيه)', 'Compare-at price (EGP)'], money: true },
  sku: { label: ['كود النسخة SKU', 'Variant SKU'] },
  isActive: { label: ['النسخة شغالة', 'Variant active'] },
};
const varKeys = (a: VarArgs) => Object.keys(VAR_FIELDS).filter(k => (a as Obj)[k] !== undefined);
const varChanges = (a: VarArgs): Obj =>
  Object.fromEntries(
    varKeys(a).map(k => [
      k,
      VAR_FIELDS[k]!.money && typeof (a as Obj)[k] === 'number'
        ? piasters((a as Obj)[k] as number)
        : (a as Obj)[k],
    ])
  );
const updateVariant = change<VarArgs>({
  name: 'variant_update',
  capabilityId: 'product.variants',
  description:
    'Edit ONE product variant: price and compare-at price in EGP (null = use the product price), SKU, or switch it on/off. Stock is not here (use the stock tools). The variant title is not editable.',
  schema: shape<VarArgs>(
    {
      productId: f.id('The product id'),
      variantId: f.id('The variant id'),
      price: f.nullable(f.num('Variant price in EGP; null = inherit the product price')),
      compareAtPrice: f.nullable(f.num('Compare-at price in EGP; null clears')),
      sku: f.nullable(f.text('Variant SKU; null clears', { max: 100 })),
      isActive: f.bool('Whether shoppers can buy this variant'),
    },
    ['productId', 'variantId']
  ),
  undo: 'reversible',
  // variant.routes.ts PUT /:storeId/products/:productId/variants/:variantId: authorize('store_admin', 'super_admin', 'staff'); VariantService.updateVariant.
  gate: { roles: ['store_admin', 'staff'] },
  audit: {
    action: 'product.variant_updated',
    resourceType: 'product_variant',
    resourceId: a => a.variantId,
  },
  refs: a => [productRef(a.productId)],
  state: async (ctx, a) => {
    const r = (await VariantService.getProductVariants(ctx.storeId, a.productId)) as {
      variants: Obj[];
    };
    const v = r.variants.find(x => x.id === a.variantId);
    if (!v) throw new Error('NOT_FOUND: that variant is not on this product');
    return {
      id: v.id,
      price: v.price ?? null,
      compareAtPrice: v.compareAtPrice ?? null,
      sku: v.sku ?? null,
      isActive: v.isActive ?? null,
    };
  },
  describe: (_ctx, a, state) => {
    const v = state as Obj;
    const keys = varKeys(a);
    if (keys.length === 0)
      throw new Error('variant_update: nothing to change; send at least one field.');
    const restore: Obj = {};
    for (const k of keys) restore[k] = VAR_FIELDS[k]!.money ? fromPiasters(v[k]) : (v[k] ?? null);
    return {
      summary: pair('هعدّل نسخة من المنتج.', 'Update a product variant.'),
      rows: keys.map(k =>
        row(
          VAR_FIELDS[k]!.label[0],
          VAR_FIELDS[k]!.label[1],
          VAR_FIELDS[k]!.money ? egp(v[k] as number | null) : (v[k] ?? null),
          (a as Obj)[k]
        )
      ),
      affectedCount: 1,
      restore,
      ...(keys.includes('price') || keys.includes('compareAtPrice') ? { changesPrice: true } : {}),
    };
  },
  run: (ctx, a) =>
    VariantService.updateVariant(ctx.storeId, a.productId, a.variantId, varChanges(a) as never),
  inverse: (a, restore) => ({
    tool: 'variant_update',
    args: { productId: a.productId, variantId: a.variantId, ...(restore as Obj) },
  }),
});

// ---- product_create --------------------------------------------------------------------------------------------------------------------------
type CreateArgs = {
  name?: string;
  nameAr?: string;
  price: number;
  description?: string;
  descriptionAr?: string;
  status?: 'draft' | 'active';
  categoryIds?: string[];
};
const createInput = (a: CreateArgs): Obj => ({
  ...(a.name !== undefined ? { name: a.name } : {}),
  ...(a.nameAr !== undefined ? { nameAr: a.nameAr } : {}),
  price: piasters(a.price),
  ...(a.description !== undefined ? { description: a.description } : {}),
  ...(a.descriptionAr !== undefined ? { descriptionAr: a.descriptionAr } : {}),
  status: a.status ?? 'draft',
  ...(a.categoryIds?.length ? { categories: a.categoryIds } : {}),
});
const createProduct = change<CreateArgs>({
  name: 'product_create',
  capabilityId: 'product.create',
  description:
    'Create a new product. Price is in EGP (a decimal such as 249.5). It starts as a draft (hidden) unless you ask for active. Give the name in Arabic, English or both.',
  schema: shape<CreateArgs>(
    {
      name: f.str('English name', { max: 255 }),
      nameAr: f.str('Arabic name', { max: 255 }),
      price: f.num('Price in EGP'),
      description: f.text('Description', { max: 5000 }),
      descriptionAr: f.text('Arabic description', { max: 5000 }),
      status: f.enum(['draft', 'active'], 'draft (default, hidden) or active (live)'),
      categoryIds: f.list(f.id(), { max: 20, description: 'Category ids in this store' }),
    },
    ['price']
  ),
  undo: 'reversible',
  // product.routes.ts POST /: requirePermission('products:write'); the same ProductService.create (plan limit maxProducts inside).
  gate: { permission: 'products:write' },
  audit: { action: 'product.created', resourceType: 'product' },
  state: async () => null, // a create has no target yet
  describe: async (ctx, a) => {
    createProductSchemaChecked.parse(createInput(a)); // the route's own validation
    const cats = a.categoryIds?.length
      ? await ProductService.getCategoriesByIds(ctx.storeId, a.categoryIds)
      : []; // 404 on a foreign category
    const status = a.status ?? 'draft';
    const nm = a.nameAr ?? a.name ?? '';
    return {
      summary: pair(
        `هضيف منتج جديد «${nm}» (${status === 'draft' ? 'مسودة' : 'منشور'}).`,
        `Create product "${a.name ?? a.nameAr}" as ${status}.`
      ),
      rows: [
        row('الاسم', 'Name', null, a.name ?? a.nameAr ?? ''),
        ...(a.nameAr && a.name ? [row('الاسم بالعربي', 'Arabic name', null, a.nameAr)] : []),
        row('السعر (جنيه)', 'Price (EGP)', null, a.price),
        row('الحالة', 'Status', null, status),
        ...(cats.length
          ? [row('التصنيفات', 'Categories', null, cats.map(c => c.name).join('، '))]
          : []),
      ],
      affectedCount: 1,
      restore: null,
      // a draft shows no price to shoppers; a live product with a price is a price decision
      ...(status === 'active' ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a) => {
    await ProductService.getCategoriesByIds(ctx.storeId, a.categoryIds ?? []);
    const p = (await ProductService.create(
      ctx.storeId,
      createProductSchemaChecked.parse(createInput(a)) as never
    )) as { id: string; name: string; status: string };
    return { productId: p.id, name: p.name, status: p.status };
  },
  inverse: (_a, _restore, result) => {
    const productId = (result as { productId?: string } | undefined)?.productId;
    return productId
      ? { tool: 'product_set_status', args: { productId, status: 'archived' } }
      : null;
  },
});

export function productsTools(): ToolSpec[] {
  return [
    updateFields,
    setStatus,
    setCategories,
    setTags,
    addFaq,
    deleteFaq,
    updateVariant,
    createProduct,
  ];
}
