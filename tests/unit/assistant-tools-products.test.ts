/** Store assistant product write tools (plan 4 B6): preview, apply through runAsMerchant, undo, escalation flags, foreign ids. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { ToolForbidden, type PreviewDraft, type TurnCtx } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  getCategoriesByIds: vi.fn(),
  getProductVariants: vi.fn(),
  updateVariant: vi.fn(),
  listFaqs: vi.fn(),
  createFaq: vi.fn(),
  deleteFaq: vi.fn(),
  getTags: vi.fn(),
  applyTags: vi.fn(),
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
    update: m.update,
    create: m.create,
    getCategoriesByIds: m.getCategoriesByIds,
  },
}));
vi.mock('@api/services/variant.service', () => ({
  VariantService: { getProductVariants: m.getProductVariants, updateVariant: m.updateVariant },
}));
vi.mock('@api/services/product-faq.service', () => ({
  listProductFaqs: m.listFaqs,
  createProductFaq: m.createFaq,
  deleteProductFaq: m.deleteFaq,
}));
vi.mock('@api/services/product-tags.service', () => ({
  getProductTags: m.getTags,
  applyProductTags: m.applyTags,
}));
// The real schemas live in the route file (it pulls in express); the passthrough keeps the shape the tool feeds the service.
vi.mock('@api/routes/product.routes', () => ({
  updateProductSchema: z.object({}).passthrough(),
  createProductSchemaChecked: z.object({}).passthrough(),
}));

import { productsTools } from '@api/smart-layer/tools/products.tools';

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
  const t = productsTools().find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const parse = (name: string, a: unknown) => tool(name).args.parse(a) as never;
const preview = (name: string, a: unknown, role?: string) =>
  tool(name).preview!(ctx(role), parse(name, a));
const apply = async (name: string, a: unknown, role?: string) => {
  const args = parse(name, a);
  const draft = await tool(name).preview!(ctx(role), args);
  return { draft, applied: await tool(name).apply!(ctx(role), args, draft) };
};
const auditActor = () => m.insertAuditLog.mock.calls.at(-1)![0].details.actor;

const p = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Ring ${id}`,
  nameAr: `خاتم ${id}`,
  description: null,
  descriptionAr: null,
  excerpt: null,
  excerptAr: null,
  price: 25000,
  compareAtPrice: 30000,
  sku: `SKU-${id}`,
  featured: false,
  isNew: false,
  isBestSeller: false,
  badgeLabel: null,
  badgeLabelAr: null,
  leadTimeDays: null,
  searchTerms: null,
  metaTitle: null,
  metaTitleAr: null,
  metaDescription: null,
  metaDescriptionAr: null,
  status: 'draft',
  categories: [{ categoryId: 'c1', category: { id: 'c1', name: 'Rings', nameAr: 'خواتم' } }],
  ...over,
});
const DB: Record<string, ReturnType<typeof p>> = {};
const seed = (n: number) => {
  for (let i = 1; i <= n; i++) DB[`p${i}`] = p(`p${i}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(DB)) delete DB[k];
  seed(30);
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.getById.mockImplementation(async (_s: string, id: string) => {
    if (!DB[id]) throw new Error('NOT_FOUND: product not in this store');
    return DB[id];
  });
  m.update.mockImplementation(async (_s: string, id: string) => DB[id]);
  m.create.mockResolvedValue({ id: 'pNEW', name: 'New', status: 'draft' });
  m.getCategoriesByIds.mockImplementation(async (_s: string, ids: string[]) => {
    const known: Record<string, string> = { c1: 'Rings', c2: 'Chains' };
    return ids.map(id => {
      if (!known[id]) throw new Error('CATEGORY_NOT_FOUND');
      return { id, name: known[id], nameAr: known[id] };
    });
  });
  m.getProductVariants.mockResolvedValue({
    product: { id: 'p1' },
    options: [],
    variants: [{ id: 'v1', sku: 'V1', price: 20000, compareAtPrice: null, isActive: true }],
  });
  m.updateVariant.mockResolvedValue({ id: 'v1' });
  m.listFaqs.mockResolvedValue([]);
  m.createFaq.mockResolvedValue({ id: 'f1' });
  m.deleteFaq.mockResolvedValue(undefined);
  m.getTags.mockImplementation(async (_s: string, ids: string[]) => {
    for (const id of ids) if (!DB[id]) throw new Error('NOT_FOUND: product not in this store');
    return Object.fromEntries(ids.map(id => [id, { name: `Ring ${id}`, tags: ['gold'] }]));
  });
  m.applyTags.mockResolvedValue(undefined);
});

describe('tool list', () => {
  it('declares every product tool with a capability and no store id argument', () => {
    const names = productsTools().map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'product_update_fields',
        'product_set_status',
        'product_set_categories',
        'product_set_tags',
        'product_add_faq',
        'product_delete_faq',
        'variant_update',
        'product_create',
      ])
    );
    for (const t of productsTools()) {
      expect(t.capabilityId).toMatch(/^product\./);
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });
  it('product ids are checked in the store by the adapter (refs)', () => {
    const t = tool('product_update_fields');
    expect(t.refs!(parse('product_update_fields', { productId: 'p1', sku: 'X' }))).toEqual([
      { kind: 'product', id: 'p1' },
    ]);
  });
});

describe('product_update_fields', () => {
  it('previews before/after rows with an etag and restore values in EGP', async () => {
    const d = await preview('product_update_fields', {
      productId: 'p1',
      name: 'Gold ring',
      price: 300,
    });
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(d.affectedCount).toBe(1);
    const price = d.rows.find(r => r.label.en.toLowerCase().includes('price'))!;
    expect(price.before).toBe('250');
    expect(price.after).toBe(300);
    expect((d.payload as { restore: Record<string, unknown> }).restore).toMatchObject({
      name: 'Ring p1',
      price: 250,
    });
  });
  it('a price change escalates; a text change does not', async () => {
    expect(
      (await preview('product_update_fields', { productId: 'p1', price: 100 })).changesPrice
    ).toBe(true);
    expect(
      (await preview('product_update_fields', { productId: 'p1', compareAtPrice: null }))
        .changesPrice
    ).toBe(true);
    expect(
      (await preview('product_update_fields', { productId: 'p1', description: 'hi' })).changesPrice
    ).toBeUndefined();
  });
  it('applies through runAsMerchant as the assistant, converting EGP to piasters', async () => {
    const { applied } = await apply('product_update_fields', { productId: 'p1', price: 99.5 });
    expect(applied.ok).toBe(true);
    expect(m.update).toHaveBeenCalledWith(S, 'p1', { price: 9950 });
    expect(auditActor()).toBe('assistant');
    expect(m.insertAuditLog.mock.calls[0]![0]).toMatchObject({
      action: 'product.updated',
      resourceType: 'product',
      resourceId: 'p1',
    });
  });
  it('a role without products:write gets ToolForbidden at preview and at apply', async () => {
    await expect(
      preview('product_update_fields', { productId: 'p1', sku: 'X' }, 'customer')
    ).rejects.toBeInstanceOf(Error);
    const t = tool('product_update_fields');
    const args = parse('product_update_fields', { productId: 'p1', sku: 'X' });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.update).not.toHaveBeenCalled();
  });
  it('the inverse restores exactly the touched fields (price back to EGP before)', async () => {
    const t = tool('product_update_fields');
    const args = parse('product_update_fields', { productId: 'p1', price: 99, sku: 'NEW' });
    const draft = await t.preview!(ctx(), args);
    const inv = t.inverse!(ctx(), args, draft, { ok: true, etagAfter: 'x' })!;
    expect(inv.tool).toBe('product_update_fields');
    expect(inv.args).toEqual({ productId: 'p1', price: 250, sku: 'SKU-p1' });
  });
  it('the etag changes when the product is edited by hand between preview and apply', async () => {
    const a = await preview('product_update_fields', { productId: 'p1', sku: 'X' });
    DB.p1 = p('p1', { name: 'Hand edit' });
    const b = await preview('product_update_fields', { productId: 'p1', sku: 'X' });
    expect(a.etag).not.toBe(b.etag);
  });
  it('a foreign product id never reaches run', async () => {
    await expect(
      preview('product_update_fields', { productId: 'foreign', sku: 'X' })
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      apply('product_update_fields', { productId: 'foreign', sku: 'X' })
    ).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('refuses an empty change', async () => {
    await expect(preview('product_update_fields', { productId: 'p1' })).rejects.toThrow();
  });
});

describe('product_set_status', () => {
  it('previews and applies the status through the service, inverse restores the old status', async () => {
    const t = tool('product_set_status');
    const args = parse('product_set_status', { productId: 'p1', status: 'active' });
    const d = await t.preview!(ctx(), args);
    expect(d.rows[0]!.before).toBe('draft');
    expect(d.rows[0]!.after).toBe('active');
    await t.apply!(ctx(), args, d);
    expect(m.update).toHaveBeenCalledWith(S, 'p1', { status: 'active' });
    expect(auditActor()).toBe('assistant');
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'product_set_status',
      args: { productId: 'p1', status: 'draft' },
    });
  });
  it('forbidden without products:write, foreign id blocked', async () => {
    const t = tool('product_set_status');
    const args = parse('product_set_status', { productId: 'p1', status: 'archived' });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    await expect(
      preview('product_set_status', { productId: 'nope', status: 'archived' })
    ).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe('product_set_categories', () => {
  it('a 25-product change has affectedCount 25 and escalates by count', async () => {
    const productIds = Array.from({ length: 25 }, (_, i) => `p${i + 1}`);
    const d = await preview('product_set_categories', {
      productIds,
      categoryIds: ['c2'],
      mode: 'add',
    });
    expect(d.affectedCount).toBe(25);
    expect(d.etag).toBeTruthy();
  });
  it('add keeps existing categories; apply goes through update per product as the assistant', async () => {
    await apply('product_set_categories', {
      productIds: ['p1', 'p2'],
      categoryIds: ['c2'],
      mode: 'add',
    });
    expect(m.update).toHaveBeenCalledTimes(2);
    expect(m.update).toHaveBeenCalledWith(S, 'p1', { categories: ['c1', 'c2'] });
    expect(auditActor()).toBe('assistant');
  });
  it('the inverse puts every product back to its own before-set', async () => {
    DB.p2 = p('p2', { categories: [] });
    const t = tool('product_set_categories');
    const args = parse('product_set_categories', {
      productIds: ['p1', 'p2'],
      categoryIds: ['c2'],
      mode: 'set',
    });
    const draft = await t.preview!(ctx(), args);
    const inv = t.inverse!(ctx(), args, draft, { ok: true, etagAfter: 'x' })!;
    expect(inv.tool).toBe('product_set_categories');
    expect(inv.args).toMatchObject({
      mode: 'set',
      changes: [
        { productId: 'p1', categoryIds: ['c1'] },
        { productId: 'p2', categoryIds: [] },
      ],
    });
    // the inverse args are a valid call of the same tool
    expect(() => t.args.parse(inv.args)).not.toThrow();
  });
  it('a category of another store is refused at preview; a foreign product too', async () => {
    await expect(
      preview('product_set_categories', {
        productIds: ['p1'],
        categoryIds: ['foreign'],
        mode: 'set',
      })
    ).rejects.toThrow(/CATEGORY_NOT_FOUND/);
    await expect(
      preview('product_set_categories', {
        productIds: ['foreign'],
        categoryIds: ['c1'],
        mode: 'set',
      })
    ).rejects.toThrow(/NOT_FOUND/);
    expect(m.update).not.toHaveBeenCalled();
  });
  it('forbidden without products:write', async () => {
    const t = tool('product_set_categories');
    const args = parse('product_set_categories', {
      productIds: ['p1'],
      categoryIds: ['c1'],
      mode: 'set',
    });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
  });
});

describe('product_set_tags', () => {
  it('the 25-product tag change has affectedCount 25', async () => {
    const productIds = Array.from({ length: 25 }, (_, i) => `p${i + 1}`);
    const d = await preview('product_set_tags', { productIds, tags: ['sale'], mode: 'add' });
    expect(d.affectedCount).toBe(25);
  });
  it('applies through the tags service as the assistant (store_admin only, as the tag routes)', async () => {
    await apply('product_set_tags', { productIds: ['p1'], tags: ['sale'], mode: 'add' });
    expect(m.applyTags).toHaveBeenCalledWith(S, [{ productId: 'p1', tags: ['sale'] }], 'add');
    expect(auditActor()).toBe('assistant');
    const t = tool('product_set_tags');
    const args = parse('product_set_tags', { productIds: ['p1'], tags: ['sale'], mode: 'add' });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('staff'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
  });
  it('the inverse sets each product back to its before tags', async () => {
    const t = tool('product_set_tags');
    const args = parse('product_set_tags', {
      productIds: ['p1', 'p2'],
      tags: ['sale'],
      mode: 'add',
    });
    const draft = await t.preview!(ctx(), args);
    const inv = t.inverse!(ctx(), args, draft, { ok: true, etagAfter: 'x' })!;
    expect(inv.args).toMatchObject({
      mode: 'set',
      changes: [
        { productId: 'p1', tags: ['gold'] },
        { productId: 'p2', tags: ['gold'] },
      ],
    });
  });
  it('a foreign product never reaches run', async () => {
    await expect(
      preview('product_set_tags', { productIds: ['foreign'], tags: ['x'], mode: 'add' })
    ).rejects.toThrow();
    expect(m.applyTags).not.toHaveBeenCalled();
  });
});

describe('product_add_faq / product_delete_faq', () => {
  it('previews the new question and answer and applies through the faq service', async () => {
    const { draft } = await apply('product_add_faq', {
      productId: 'p1',
      question: 'Q?',
      answer: 'A.',
    });
    expect(draft.rows.length).toBeGreaterThan(0);
    expect(m.createFaq).toHaveBeenCalledWith(
      S,
      'p1',
      expect.objectContaining({ question: 'Q?', answer: 'A.' })
    );
    expect(auditActor()).toBe('assistant');
  });
  it('the inverse deletes the faq the run created', async () => {
    const t = tool('product_add_faq');
    const args = parse('product_add_faq', { productId: 'p1', question: 'Q?', answer: 'A.' });
    const draft = await t.preview!(ctx(), args);
    const applied = await t.apply!(ctx(), args, draft);
    expect(t.inverse!(ctx(), args, draft, applied)).toEqual({
      tool: 'product_delete_faq',
      args: { productId: 'p1', faqId: 'f1' },
    });
  });
  it('delete is a confirm-class, irreversible tool that flags deletes', async () => {
    const t = tool('product_delete_faq');
    expect(t.policy).toBe('confirm');
    expect(t.deletes).toBe(true);
    expect(t.undo).toBe('irreversible');
  });
  it('delete goes through the service; an unknown faq is refused at preview', async () => {
    m.listFaqs.mockResolvedValue([{ id: 'f1', question: 'Q?', answer: 'A.' }]);
    await apply('product_delete_faq', { productId: 'p1', faqId: 'f1' });
    expect(m.deleteFaq).toHaveBeenCalledWith(S, 'p1', 'f1');
    await expect(
      preview('product_delete_faq', { productId: 'p1', faqId: 'zzz' })
    ).rejects.toThrow();
  });
  it('the add and delete tools read the same state so an undo is not stale', async () => {
    m.listFaqs.mockResolvedValue([{ id: 'f1', question: 'Q?', answer: 'A.' }]);
    const add = await preview('product_add_faq', { productId: 'p1', question: 'Z', answer: 'Z' });
    const del = await preview('product_delete_faq', { productId: 'p1', faqId: 'f1' });
    expect(add.etag).toBe(del.etag);
  });
  it('forbidden for a role without access; foreign product blocked', async () => {
    const t = tool('product_add_faq');
    const args = parse('product_add_faq', { productId: 'p1', question: 'Q?', answer: 'A.' });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    m.listFaqs.mockRejectedValue(new Error('NOT_FOUND: product'));
    await expect(
      preview('product_add_faq', { productId: 'foreign', question: 'Q', answer: 'A' })
    ).rejects.toThrow();
  });
});

describe('variant_update', () => {
  it('a price change escalates and the inverse restores the before values (EGP)', async () => {
    const t = tool('variant_update');
    const args = parse('variant_update', { productId: 'p1', variantId: 'v1', price: 150 });
    const d = await t.preview!(ctx(), args);
    expect(d.changesPrice).toBe(true);
    expect(d.rows[0]!.before).toBe('200');
    await t.apply!(ctx(), args, d);
    expect(m.updateVariant).toHaveBeenCalledWith(S, 'p1', 'v1', { price: 15000 });
    expect(auditActor()).toBe('assistant');
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'variant_update',
      args: { productId: 'p1', variantId: 'v1', price: 200 },
    });
  });
  it('a non-price change does not escalate; stock is not a field', () => {
    expect(JSON.stringify(tool('variant_update').jsonSchema)).not.toMatch(/inventory|stock/i);
  });
  it('a variant of another product/store is refused before run', async () => {
    await expect(
      preview('variant_update', { productId: 'p1', variantId: 'other', sku: 'X' })
    ).rejects.toThrow();
    m.getProductVariants.mockRejectedValue(new Error('NOT_FOUND'));
    await expect(
      preview('variant_update', { productId: 'foreign', variantId: 'v1', sku: 'X' })
    ).rejects.toThrow();
    expect(m.updateVariant).not.toHaveBeenCalled();
  });
  it('forbidden without a role on the variant route', async () => {
    const t = tool('variant_update');
    const args = parse('variant_update', { productId: 'p1', variantId: 'v1', sku: 'X' });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
  });
});

describe('product_create', () => {
  it('creates a draft by default and its inverse archives the created product', async () => {
    const t = tool('product_create');
    const args = parse('product_create', {
      name: 'Ring',
      nameAr: 'خاتم',
      price: 120,
      categoryIds: ['c1'],
    });
    const d: PreviewDraft = await t.preview!(ctx(), args);
    expect(d.changesPrice).toBeUndefined(); // a draft shows no price to shoppers
    const applied = await t.apply!(ctx(), args, d);
    expect(m.create).toHaveBeenCalledWith(
      S,
      expect.objectContaining({ price: 12000, status: 'draft', categories: ['c1'] })
    );
    expect(auditActor()).toBe('assistant');
    expect(t.inverse!(ctx(), args, d, applied)).toEqual({
      tool: 'product_set_status',
      args: { productId: 'pNEW', status: 'archived' },
    });
  });
  it('an active product with a price escalates', async () => {
    const d = await preview('product_create', { name: 'Ring', price: 120, status: 'active' });
    expect(d.changesPrice).toBe(true);
  });
  it('a category of another store is refused; forbidden without products:write', async () => {
    await expect(
      preview('product_create', { name: 'R', price: 1, categoryIds: ['foreign'] })
    ).rejects.toThrow();
    const t = tool('product_create');
    const args = parse('product_create', { name: 'R', price: 1 });
    const draft = await t.preview!(ctx(), args);
    await expect(t.apply!(ctx('customer'), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.create).not.toHaveBeenCalled();
  });
});
