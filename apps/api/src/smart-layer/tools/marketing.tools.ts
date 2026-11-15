/**
 * Wave 1 (plan 4 B6): marketing change tools. One `change()` per tool; each gate is the SAME role / feature the admin route for that screen demands
 * (cited at each tool), each `run` calls the SAME service the route calls. Money in tool arguments is EGP (a decimal number); the tools convert to
 * integer piasters with Math.round(x * 100) before they reach a service. Deleting a coupon / bundle is NOT here (wave 2, confirm).
 */
import type {
  AppliedResult,
  InverseOp,
  PreviewDraft,
  ToolSpec,
  TurnCtx,
} from '@ebda/shared/smart-layer';
import { AppError } from '../../middleware/error-handler';
import { assertCouponValue } from '../../lib/sellable-price';
import { storeDb } from '../../lib/repo-factory';
import { CouponService } from '../../services/coupon.service';
import { recommendationService } from '../../services/recommendation.service';
import { abandonedCartService } from '../../services/abandoned-cart.service';
import { change, diffRows, f, pair, pick, row, shape, type Described } from './kit';

const toMinor = (x: number): number => Math.round(x * 100);
const fromMinor = (x: number | null | undefined): number | null =>
  x === null || x === undefined ? null : x / 100;
const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const toDate = (s: string | null | undefined): Date | null | undefined => {
  if (s === undefined) return undefined;
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()))
    throw new Error(`Invalid date: ${s} (use ISO 8601, e.g. 2026-12-01T00:00:00Z)`);
  return d;
};
const defined = (o: Record<string, unknown>): string[] =>
  Object.keys(o).filter(k => o[k] !== undefined);

/**
 * `change()`'s inverse wrapper does not forward the applied result to the tool's inverse (kit.ts `inverse: (_ctx, a, draft) => ...`), so a create
 * tool that undoes through the NEW row's id re-declares `inverse` here, reading `applied.result`. Reduces to the kit's own when it is fixed.
 */
export function withRunResultInverse(
  spec: ToolSpec,
  inverse: (a: unknown, result: unknown) => InverseOp | null
): ToolSpec {
  return {
    ...spec,
    inverse: (_ctx: TurnCtx, a: unknown, _draft: PreviewDraft, applied: AppliedResult) =>
      inverse(a, applied.result),
  } as unknown as ToolSpec;
}

// ---- coupons ----------------------------------------------------------------------------------------------------------------------------------
// routes/coupon.routes.ts: authorize(store_admin, super_admin) + requireFeature('coupons'); the assistant never acts as super_admin.
const COUPON_GATE = { roles: ['store_admin'], feature: 'coupons' } as const;

type CouponRow = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  value: number;
  minOrderAmount: number | null;
  maxDiscount: number | null;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  updatedAt: Date;
};

/** A coupon in the tool's own units (EGP for money), keyed like the tool arguments. */
function couponView(c: CouponRow): Record<string, unknown> {
  return {
    code: c.code,
    name: c.name,
    nameAr: c.nameAr ?? null,
    type: c.type,
    value: c.type === 'fixed' ? c.value / 100 : c.value,
    minOrderEgp: fromMinor(c.minOrderAmount),
    maxDiscountEgp: fromMinor(c.maxDiscount),
    usageLimit: c.usageLimit,
    usageLimitPerUser: c.usageLimitPerUser,
    startsAt: iso(c.startsAt),
    expiresAt: iso(c.expiresAt),
  };
}
const COUPON_LABELS: Record<string, [string, string]> = {
  code: ['كود الكوبون', 'Coupon code'],
  name: ['اسم الكوبون', 'Coupon name'],
  nameAr: ['الاسم بالعربي', 'Arabic name'],
  type: ['نوع الخصم', 'Discount type'],
  value: ['قيمة الخصم', 'Discount value'],
  minOrderEgp: ['أقل قيمة للطلب (جنيه)', 'Minimum order (EGP)'],
  maxDiscountEgp: ['أقصى خصم (جنيه)', 'Maximum discount'],
  usageLimit: ['عدد مرات الاستخدام', 'Usage limit'],
  usageLimitPerUser: ['حد الاستخدام للعميل', 'Usage limit per customer'],
  startsAt: ['يبدأ في', 'Starts at'],
  expiresAt: ['ينتهي في', 'Expires at'],
};
const PRICE_KEYS = ['type', 'value', 'minOrderEgp', 'maxDiscountEgp'];

type CouponInput = {
  code?: string;
  name?: string;
  nameAr?: string | null;
  type?: 'percentage' | 'fixed';
  value?: number;
  minOrderEgp?: number | null;
  maxDiscountEgp?: number | null;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
};
/** Tool arguments -> CouponService data (piasters, Dates). Only the keys given. */
function couponData(a: CouponInput, type: string): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (a.code !== undefined) d.code = a.code.toUpperCase();
  if (a.name !== undefined) d.name = a.name;
  if (a.nameAr !== undefined) d.nameAr = a.nameAr;
  if (a.type !== undefined) d.type = a.type;
  if (a.value !== undefined) d.value = type === 'fixed' ? toMinor(a.value) : a.value;
  if (a.minOrderEgp !== undefined)
    d.minOrderAmount = a.minOrderEgp === null ? null : toMinor(a.minOrderEgp);
  if (a.maxDiscountEgp !== undefined)
    d.maxDiscount = a.maxDiscountEgp === null ? null : toMinor(a.maxDiscountEgp);
  if (a.usageLimit !== undefined) d.usageLimit = a.usageLimit;
  if (a.usageLimitPerUser !== undefined) d.usageLimitPerUser = a.usageLimitPerUser;
  if (a.startsAt !== undefined) d.startsAt = toDate(a.startsAt);
  if (a.expiresAt !== undefined) d.expiresAt = toDate(a.expiresAt);
  return d;
}
/** Same rule as the route's schema + CouponService (QA-PRICE-ZERO-1, BE:S-24), run at PREVIEW so a card never promises a write the service will refuse. */
function assertCouponValid(type: string, value: number): void {
  const stored = type === 'fixed' ? toMinor(value) : value;
  if (type === 'percentage' && (!Number.isInteger(value) || value < 1 || value > 100))
    throw new Error('A percentage coupon must be a whole number from 1 to 100');
  assertCouponValue(type, stored);
}

const couponFields = {
  name: f.str('Coupon name', { max: 100 }),
  nameAr: f.nullable(f.str('Arabic name', { max: 100 })),
  type: f.enum(
    ['percentage', 'fixed'],
    'percentage = whole percent 1-100; fixed = amount off in EGP'
  ),
  value: f.num(
    'Discount value: a whole percent (1-100) for percentage, or an amount in EGP for fixed'
  ),
  minOrderEgp: f.nullable(f.num('Minimum order total in EGP; null removes the minimum')),
  maxDiscountEgp: f.nullable(f.num('Maximum discount in EGP; null removes the cap')),
  usageLimit: f.nullable(f.int('Total uses allowed; null = unlimited', { min: 1 })),
  usageLimitPerUser: f.nullable(f.int('Uses allowed per customer; null = unlimited', { min: 1 })),
  startsAt: f.nullable(f.str('Start date-time, ISO 8601; null = starts now', { max: 40 })),
  expiresAt: f.nullable(f.str('Expiry date-time, ISO 8601; null = never expires', { max: 40 })),
};

type CouponCreateArgs = CouponInput & {
  code: string;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
};
const couponCreate = withRunResultInverse(
  change<CouponCreateArgs>({
    name: 'coupon_create',
    capabilityId: 'marketing.coupons',
    description:
      'Create a discount coupon (a code shoppers type at checkout). type percentage = whole percent 1-100; type fixed = amount off, value/min order/max discount in EGP (decimal). It starts active.',
    schema: shape<CouponCreateArgs>(
      { code: f.str('Coupon code, e.g. EID10', { max: 50 }), ...couponFields },
      ['code', 'name', 'type', 'value']
    ),
    undo: 'compensating',
    gate: COUPON_GATE,
    audit: { action: 'coupon.created', resourceType: 'coupon' },
    state: async () => null,
    describe: (_ctx, a): Described => {
      assertCouponValid(a.type, a.value);
      couponData(a, a.type); // validates the dates now, not at apply
      const after = { ...a, code: a.code.toUpperCase() } as Record<string, unknown>;
      const shown = defined(after).filter(k => k in COUPON_LABELS);
      return {
        summary: pair(
          `هعمل كوبون ${after.code} بخصم ${a.value}${a.type === 'percentage' ? '%' : ' جنيه'} وهيبقى شغّال علطول.`,
          `I will create coupon ${after.code}: ${a.value}${a.type === 'percentage' ? '%' : ' EGP'} off, active right away.`
        ),
        rows: shown.map(k => row(COUPON_LABELS[k]![0], COUPON_LABELS[k]![1], null, after[k])),
        affectedCount: 1,
        changesPrice: true,
        restore: null,
      };
    },
    run: async (ctx, a) => {
      const c = await CouponService.create(ctx.storeId, couponData(a, a.type) as never);
      return { couponId: (c as { id: string }).id, code: (c as { code: string }).code };
    },
  }),
  (_a, result) => {
    const id = (result as { couponId?: string } | undefined)?.couponId;
    return id ? { tool: 'coupon_toggle', args: { couponId: id, active: false } } : null;
  }
);

type CouponToggleArgs = { couponId: string; active: boolean };
async function readCoupon(ctx: TurnCtx, id: string): Promise<CouponRow> {
  // The store-scoped service 404s an id that is not this store's: a foreign id never gets past state().
  return (await CouponService.getById(ctx.storeId, id)) as unknown as CouponRow;
}
const couponToggle = change<CouponToggleArgs>({
  name: 'coupon_toggle',
  capabilityId: 'marketing.coupons',
  description:
    'Activate (active=true) or deactivate (active=false) one coupon. Deactivating stops it working at checkout; the coupon is kept.',
  schema: shape<CouponToggleArgs>(
    { couponId: f.id('The coupon id'), active: f.bool('true = switch on, false = switch off') },
    ['couponId', 'active']
  ),
  undo: 'reversible',
  gate: COUPON_GATE,
  audit: { action: 'coupon.toggled', resourceType: 'coupon', resourceId: a => a.couponId },
  state: async (ctx, a) => {
    const c = await readCoupon(ctx, a.couponId);
    return {
      id: c.id,
      code: c.code,
      type: c.type,
      isActive: c.isActive,
      updatedAt: iso(c.updatedAt),
    };
  },
  describe: (_ctx, a, st): Described => {
    const s = st as { code: string; type: string; isActive: boolean };
    const changes = s.isActive !== a.active;
    return {
      summary: pair(
        changes
          ? `هـ${a.active ? 'شغّل' : 'وقّف'} الكوبون ${s.code}.`
          : `الكوبون ${s.code} أصلاً ${a.active ? 'شغّال' : 'موقوف'}، مفيش حاجة هتتغيّر.`,
        changes
          ? `I will switch coupon ${s.code} ${a.active ? 'on' : 'off'}.`
          : `Coupon ${s.code} is already ${a.active ? 'on' : 'off'}; nothing changes.`
      ),
      rows: [row('شغّال', 'Active', s.isActive, a.active)],
      affectedCount: changes ? 1 : 0,
      restore: { active: s.isActive },
      ...(changes && s.type !== 'free_shipping' ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a, st) => {
    // The route's PATCH /:id/toggle flips; asking for the state it already has must change nothing (an undo can arrive late).
    if ((st as { isActive: boolean }).isActive === a.active)
      return { couponId: a.couponId, unchanged: true };
    const c = await CouponService.toggleActive(ctx.storeId, a.couponId);
    return { couponId: a.couponId, isActive: (c as { isActive: boolean }).isActive };
  },
  inverse: (a, restore) => ({
    tool: 'coupon_toggle',
    args: { couponId: a.couponId, active: (restore as { active: boolean }).active },
  }),
});

type CouponUpdateArgs = CouponInput & { couponId: string };
const couponUpdate = change<CouponUpdateArgs>({
  name: 'coupon_update',
  capabilityId: 'marketing.coupons',
  description:
    'Change fields of one coupon. Send only the fields to change (null clears a limit or date). If you change the type send the value too. Money in EGP (decimal). To switch it on/off use coupon_toggle.',
  schema: shape<CouponUpdateArgs>(
    { couponId: f.id('The coupon id'), code: f.str('New code', { max: 50 }), ...couponFields },
    ['couponId']
  ),
  undo: 'reversible',
  gate: COUPON_GATE,
  audit: { action: 'coupon.updated', resourceType: 'coupon', resourceId: a => a.couponId },
  state: async (ctx, a) => {
    const c = await readCoupon(ctx, a.couponId);
    return { view: couponView(c), type: c.type, updatedAt: iso(c.updatedAt) };
  },
  describe: (_ctx, a, st): Described => {
    const s = st as { view: Record<string, unknown>; type: string };
    const { couponId: _id, ...fields } = a;
    const touched = defined(fields);
    if (touched.length === 0) throw new Error('Nothing to change: send at least one field.');
    if (touched.includes('type') && !touched.includes('value'))
      throw new Error('Send the value together with the type when changing the type.');
    if (s.type === 'free_shipping' && touched.some(k => k === 'type' || k === 'value'))
      throw new Error('A free-shipping coupon has no discount value.');
    const type = a.type ?? s.type;
    if (a.value !== undefined) assertCouponValid(type, a.value);
    couponData(a, type); // validates the dates now
    const after = Object.fromEntries(touched.map(k => [k, (fields as Record<string, unknown>)[k]]));
    return {
      summary: pair(
        `هعدّل الكوبون ${String(s.view.code)}.`,
        `I will edit coupon ${String(s.view.code)}.`
      ),
      rows: diffRows(COUPON_LABELS, s.view, after),
      affectedCount: 1,
      restore: pick(s.view, touched),
      ...(touched.some(k => PRICE_KEYS.includes(k)) ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a, st) => {
    const { couponId, ...fields } = a;
    const type = a.type ?? (st as { type: string }).type;
    return CouponService.update(ctx.storeId, couponId, couponData(fields, type) as never).then(
      () => ({ couponId })
    );
  },
  inverse: (a, restore) => ({
    tool: 'coupon_update',
    args: { couponId: a.couponId, ...(restore as object) },
  }),
});

// ---- bundles ----------------------------------------------------------------------------------------------------------------------------------
// routes/bundle.routes.ts adminMiddleware: authorize(store_admin, super_admin) + requireFeature('bundles'). Logic = createBundle() extracted from the route.
const BUNDLE_GATE = { roles: ['store_admin'], feature: 'bundles' } as const;
type BundleCreateArgs = {
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string | null;
  descriptionAr?: string | null;
  pricingType: 'fixed_price' | 'percentage' | 'fixed';
  pricingValue: number;
  items: Array<{ productId: string; variantId?: string | null; quantity: number }>;
  isActive?: boolean;
  startsAt?: string | null;
  expiresAt?: string | null;
};
const bundleItemShape = {
  productId: f.id('Product id'),
  variantId: f.nullable(f.id('Variant id (omit for a product without variants)')),
  quantity: f.int('How many of this component per bundle (1-1000)', { min: 1, max: 1000 }),
};
const bundleCreate = change<BundleCreateArgs>({
  name: 'bundle_create',
  capabilityId: 'marketing.bundles',
  description:
    'Create a product bundle sold as one item. pricingType fixed_price = the bundle costs pricingValue EGP; fixed = pricingValue EGP off the component total; percentage = pricingValue percent (0-100) off. Components are product ids (max 50, no repeats).',
  schema: shape<BundleCreateArgs>(
    {
      name: f.str('Bundle name', { max: 150 }),
      nameAr: f.nullable(f.str('Arabic name', { max: 150 })),
      slug: f.str('URL slug: lowercase letters, digits and dashes', { max: 255 }),
      description: f.nullable(f.text('Description', { max: 2000 })),
      descriptionAr: f.nullable(f.text('Arabic description', { max: 2000 })),
      pricingType: f.enum(['fixed_price', 'percentage', 'fixed']),
      pricingValue: f.num('EGP for fixed_price and fixed; a percent (0-100) for percentage'),
      items: f.list(f.obj(bundleItemShape, ['productId', 'quantity']), { min: 1, max: 50 }),
      isActive: f.bool('Default true'),
      startsAt: f.nullable(f.str('ISO 8601 start; null = now', { max: 40 })),
      expiresAt: f.nullable(f.str('ISO 8601 end; null = never', { max: 40 })),
    },
    ['name', 'slug', 'pricingType', 'pricingValue', 'items']
  ),
  undo: 'irreversible', // the delete tool is wave 2 (confirm); until then a created bundle is removed by the merchant on the Bundles screen
  gate: BUNDLE_GATE,
  audit: { action: 'bundle.created', resourceType: 'bundle' },
  refs: a => a.items.map(i => ({ kind: 'product', id: i.productId })),
  state: async (ctx, a) => {
    const ids = [...new Set(a.items.map(i => i.productId))];
    const rows = (await (
      await storeDb(ctx.storeId)
    ).product.findMany({
      where: { id: { in: ids }, storeId: ctx.storeId },
      select: { id: true, name: true, price: true, updatedAt: true },
    })) as Array<{ id: string; name: string; price: number | null; updatedAt: Date }>;
    if (rows.length !== ids.length)
      throw new AppError(404, 'NOT_FOUND', 'A bundle component is not a product of this store');
    return rows
      .map(r => ({ id: r.id, name: r.name, price: r.price, updatedAt: iso(r.updatedAt) }))
      .sort((x, y) => x.id.localeCompare(y.id));
  },
  describe: (_ctx, a, st): Described => {
    if (!/^[a-z0-9؀-ۿ-]+$/.test(a.slug))
      throw new Error('Slug: lowercase letters, digits and dashes only.');
    if (a.pricingType === 'percentage' && a.pricingValue > 100)
      throw new Error('A percentage bundle discount is 0 to 100.');
    toDate(a.startsAt);
    toDate(a.expiresAt);
    const names = new Map((st as Array<{ id: string; name: string }>).map(p => [p.id, p.name]));
    const pricing = a.pricingType === 'percentage' ? `${a.pricingValue}%` : `${a.pricingValue} EGP`;
    return {
      summary: pair(
        `هعمل باقة "${a.name}" من ${a.items.length} منتج، التسعير: ${pricing}.`,
        `I will create the bundle "${a.name}" from ${a.items.length} product(s), pricing: ${pricing}.`
      ),
      rows: [
        row('اسم الباقة', 'Bundle name', null, a.name),
        row('طريقة التسعير', 'Pricing', null, `${a.pricingType}: ${pricing}`),
        row(
          'المكوّنات',
          'Components',
          null,
          a.items.map(i => `${names.get(i.productId) ?? i.productId} x${i.quantity}`)
        ),
        row('شغّالة', 'Active', null, a.isActive ?? true),
      ],
      affectedCount: 1,
      changesPrice: true,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    // Loaded on use: the route module pulls in the whole bundle stack, which only a bundle write needs.
    const { createBundle, createSchema } = await import('../../routes/bundle.routes.js');
    const data = createSchema.parse({
      ...a,
      pricingValue:
        a.pricingType === 'percentage' ? Math.round(a.pricingValue * 100) : toMinor(a.pricingValue),
    });
    const b = await createBundle(ctx.storeId, data);
    return { bundleId: (b as { id: string }).id };
  },
});

// ---- product recommendations ------------------------------------------------------------------------------------------------------------------
// routes/recommendation.routes.ts PUT /:storeId/products/:productId/relations: authorize(store_admin, super_admin) + requireFeature('upsell_crosssell').
type RecArgs = { productId: string; crossSellProductIds?: string[]; upsellProductIds?: string[] };
type RelRow = { type: string; position: number; targetProduct: { id: string; name?: string } };
const uniq = (xs: string[] | undefined): string[] => [...new Set(xs ?? [])];
const recommendationsSet = change<RecArgs>({
  name: 'recommendations_set',
  capabilityId: 'product.recommendations',
  description:
    'Replace the hand-picked "you might also like" lists of ONE product: crossSellProductIds (shown as related / bought together) and upsellProductIds (better versions). It REPLACES both lists; send the full lists you want. Max 25 each.',
  schema: shape<RecArgs>(
    {
      productId: f.id('The product whose recommendations to set'),
      crossSellProductIds: f.list(f.id(), {
        max: 25,
        description: 'Related products, in display order',
      }),
      upsellProductIds: f.list(f.id(), {
        max: 25,
        description: 'Upsell products, in display order',
      }),
    },
    ['productId']
  ),
  undo: 'reversible',
  gate: { roles: ['store_admin'], feature: 'upsell_crosssell' },
  audit: { action: 'product.relations_set', resourceType: 'product', resourceId: a => a.productId },
  refs: a =>
    [a.productId, ...uniq(a.crossSellProductIds), ...uniq(a.upsellProductIds)].map(id => ({
      kind: 'product',
      id,
    })),
  state: async (ctx, a) => {
    const rels = (await recommendationService.getRelations(
      ctx.storeId,
      a.productId
    )) as unknown as RelRow[];
    return rels.map(r => ({
      type: r.type,
      position: r.position,
      id: r.targetProduct.id,
      name: r.targetProduct.name ?? null,
    }));
  },
  describe: (_ctx, a, st): Described => {
    const cross = uniq(a.crossSellProductIds);
    const up = uniq(a.upsellProductIds);
    if (cross.includes(a.productId) || up.includes(a.productId))
      throw new Error('A product cannot recommend itself.');
    const rels = st as Array<{ type: string; position: number; id: string }>;
    const ids = (type: string) =>
      rels
        .filter(r => r.type === type)
        .sort((x, y) => x.position - y.position)
        .map(r => r.id);
    return {
      summary: pair(
        `هغيّر المنتجات المقترحة للمنتج: ${cross.length} مرتبطة و${up.length} ترقية.`,
        `I will replace this product's recommendations: ${cross.length} related and ${up.length} upsell.`
      ),
      rows: [
        row('منتجات مرتبطة', 'Related products', ids('cross_sell'), cross),
        row('منتجات ترقية', 'Upsell products', ids('upsell'), up),
      ],
      affectedCount: cross.length + up.length,
      restore: { crossSellProductIds: ids('cross_sell'), upsellProductIds: ids('upsell') },
    };
  },
  run: async (ctx, a) => {
    const relations = [
      ...uniq(a.crossSellProductIds).map((id, position) => ({
        targetProductId: id,
        type: 'cross_sell',
        position,
      })),
      ...uniq(a.upsellProductIds).map((id, position) => ({
        targetProductId: id,
        type: 'upsell',
        position,
      })),
    ];
    await recommendationService.setProductRelations(ctx.storeId, a.productId, relations);
    return { productId: a.productId, count: relations.length };
  },
  inverse: (a, restore) => ({
    tool: 'recommendations_set',
    args: { productId: a.productId, ...(restore as object) },
  }),
});

// ---- abandoned-cart reminder settings ---------------------------------------------------------------------------------------------------------
// routes/abandoned-cart.routes.ts PUT /:storeId/abandoned-carts/config: authorize(store_admin, super_admin) + requireFeature('abandoned_cart').
// Only the SETTINGS change here; the recovery job (not this tool) sends the emails, when a shopper has consented.
type CartArgs = {
  step1Enabled?: boolean;
  step1DelayMinutes?: number;
  step2Enabled?: boolean;
  step2DelayMinutes?: number;
  step3Enabled?: boolean;
  step3DelayMinutes?: number;
  autoCouponEnabled?: boolean;
  couponDiscountPercent?: number;
  couponMaxDiscountEgp?: number | null;
  couponExpiryHours?: number;
  emailEnabled?: boolean;
  emailDelayMinutes?: number;
};
type CartConfig = Record<string, unknown> & { couponMaxDiscount: number | null };
const CART_LABELS: Record<string, [string, string]> = {
  step1Enabled: ['تذكير 1 شغّال', 'Reminder 1 on'],
  step1DelayMinutes: ['تذكير 1 بعد (دقيقة)', 'Reminder 1 delay (minutes)'],
  step2Enabled: ['تذكير 2 شغّال', 'Reminder 2 on'],
  step2DelayMinutes: ['تذكير 2 بعد (دقيقة)', 'Reminder 2 delay (minutes)'],
  step3Enabled: ['تذكير 3 شغّال', 'Reminder 3 on'],
  step3DelayMinutes: ['تذكير 3 بعد (دقيقة)', 'Reminder 3 delay (minutes)'],
  autoCouponEnabled: ['كوبون تلقائي', 'Automatic coupon'],
  couponDiscountPercent: ['نسبة خصم الكوبون %', 'Coupon discount %'],
  couponMaxDiscountEgp: ['أقصى خصم للكوبون (جنيه)', 'Coupon maximum (EGP)'],
  couponExpiryHours: ['صلاحية الكوبون (ساعة)', 'Coupon validity (hours)'],
  emailEnabled: ['إيميلات العملاء', 'Customer emails'],
  emailDelayMinutes: ['إيميل بعد (دقيقة)', 'Customer emails delay (minutes)'],
};
const cartView = (c: CartConfig): Record<string, unknown> => {
  const { couponMaxDiscount, ...rest } = c;
  return { ...rest, couponMaxDiscountEgp: fromMinor(couponMaxDiscount) };
};
const abandonedCartSettings = change<CartArgs>({
  name: 'abandoned_cart_settings',
  capabilityId: 'marketing.abandoned-carts',
  description:
    'Change the abandoned-cart recovery SETTINGS (reminder steps on/off and delays in minutes, the automatic recovery coupon, the customer e-mail and its delay 60-1440 minutes). Send only what changes. Turning a reminder or the customer e-mail on makes the store e-mail shoppers who left a cart, on a schedule. Coupon cap in EGP.',
  schema: shape<CartArgs>({
    step1Enabled: f.bool(),
    step1DelayMinutes: f.int('minutes', { min: 1 }),
    step2Enabled: f.bool(),
    step2DelayMinutes: f.int('minutes', { min: 1 }),
    step3Enabled: f.bool(),
    step3DelayMinutes: f.int('minutes', { min: 1 }),
    autoCouponEnabled: f.bool('Automatic recovery coupon (a discount)'),
    couponDiscountPercent: f.num('0-100', { max: 100 }),
    couponMaxDiscountEgp: f.nullable(f.num('EGP cap; null = no cap')),
    couponExpiryHours: f.int('hours', { min: 1 }),
    emailEnabled: f.bool('Customer recovery e-mail'),
    emailDelayMinutes: f.int('minutes, 60 to 1440', { min: 60, max: 1440 }),
  }),
  undo: 'reversible',
  gate: { roles: ['store_admin'], feature: 'abandoned_cart' },
  audit: { action: 'abandoned_cart.config_updated', resourceType: 'abandoned_cart_config' },
  state: async ctx =>
    cartView((await abandonedCartService.getConfig(ctx.storeId)) as unknown as CartConfig),
  describe: (_ctx, a, st): Described => {
    const before = st as Record<string, unknown>;
    const touched = defined(a);
    if (touched.length === 0) throw new Error('Nothing to change: send at least one setting.');
    const rows = diffRows(
      CART_LABELS,
      before,
      Object.fromEntries(touched.map(k => [k, (a as Record<string, unknown>)[k]]))
    );
    const emails =
      a.emailEnabled === true ||
      a.step1Enabled === true ||
      a.step2Enabled === true ||
      a.step3Enabled === true;
    const sending = emails
      ? [
          row(
            'إيميلات العملاء',
            'Customer emails',
            before.emailEnabled,
            `${(a.emailEnabled ?? before.emailEnabled) ? `شغّالة، هتتبعت لأي عميل ساب سلة بعد ${a.emailDelayMinutes ?? before.emailDelayMinutes} دقيقة` : 'حسب إعدادات التذكير'} | on a schedule to shoppers who left a cart`
          ),
        ]
      : [];
    return {
      summary: pair(
        emails
          ? 'هغيّر إعدادات استرجاع السلة المتروكة، وده هيبعت إيميلات للعملاء بشكل تلقائي.'
          : 'هغيّر إعدادات استرجاع السلة المتروكة.',
        emails
          ? 'I will change the abandoned-cart settings; this makes the store e-mail shoppers automatically.'
          : 'I will change the abandoned-cart settings.'
      ),
      rows: [
        ...rows.filter(r => r.label.en !== 'Customer emails' || sending.length === 0),
        ...sending,
      ],
      affectedCount: 1,
      restore: pick(before, touched),
      ...(touched.some(k =>
        ['autoCouponEnabled', 'couponDiscountPercent', 'couponMaxDiscountEgp'].includes(k)
      )
        ? { changesPrice: true }
        : {}),
    };
  },
  run: async (ctx, a) => {
    const { couponMaxDiscountEgp, ...rest } = a;
    const data: Record<string, unknown> = { ...rest };
    if (couponMaxDiscountEgp !== undefined)
      data.couponMaxDiscount = couponMaxDiscountEgp === null ? null : toMinor(couponMaxDiscountEgp);
    await abandonedCartService.upsertConfig(ctx.storeId, data as never);
    return { updated: Object.keys(data) };
  },
  inverse: (_a, restore) => ({ tool: 'abandoned_cart_settings', args: restore }),
});

export function marketingTools(): ToolSpec[] {
  return [
    couponCreate,
    couponToggle,
    couponUpdate,
    bundleCreate,
    recommendationsSet,
    abandonedCartSettings,
  ];
}
