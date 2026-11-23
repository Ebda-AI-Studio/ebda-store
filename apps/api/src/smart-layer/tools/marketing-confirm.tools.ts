/**
 * Wave 2 (plan 4 C2): marketing confirm-class tools. Declared with `change()` from ./kit; money in tool arguments is EGP (decimal), converted with
 * Math.round(x * 100) before a service sees it.
 *   - promotion_create / promotion_toggle (marketing.promotions): routes/promotion.routes.ts POST / PATCH :id/toggle, `authorize(store_admin, super_admin)`
 *     (no plan feature, no permission); same PromotionService. A promotion is an AUTOMATIC discount every matching shopper gets at once: confirm,
 *     `changesPrice` + `touchesCheckout`. create undoes by switching the new promotion off (compensating); toggle restores the before state.
 *   - coupon_delete (marketing.coupons): coupon.routes.ts DELETE :id, `authorize(store_admin, super_admin)` + `requireFeature('coupons')`; same
 *     CouponService.delete, a HARD delete with no restore: confirm, `deletes`, irreversible. Deactivating (coupon_toggle) is the reversible alternative.
 */
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { PromotionService } from '../../services/promotion.service';
import { CouponService } from '../../services/coupon.service';
import { change, f, pair, row, shape, type Described } from './kit';

const GATE = { roles: ['store_admin'] } as const;
const toMinor = (x: number): number => Math.round(x * 100);
const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const parseDate = (s: string | null | undefined): Date | null => {
  if (s === undefined || s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()))
    throw new Error(`Invalid date: ${s} (use ISO 8601, e.g. 2026-12-01T00:00:00Z)`);
  return d;
};

type PromoRow = {
  id: string;
  name: string;
  type: string;
  value: number;
  isActive: boolean;
  scopeProductIds: string[];
  startsAt: Date | null;
  expiresAt: Date | null;
  updatedAt: Date;
};
const readPromotion = async (ctx: TurnCtx, id: string): Promise<PromoRow> =>
  // store-scoped: 404s an id that is not this store's promotion
  (await PromotionService.getById(ctx.storeId, id)) as unknown as PromoRow;

// ---- promotion_create ------------------------------------------------------------------------------------------------------------------------
type PromoCreateArgs = {
  name: string;
  nameAr?: string | null;
  type: 'percentage' | 'fixed';
  value: number;
  maxDiscountEgp?: number | null;
  minOrderEgp?: number | null;
  minQuantity?: number | null;
  firstOrderOnly?: boolean;
  scopeProductIds?: string[];
  startsAt?: string | null;
  expiresAt?: string | null;
};
const promotionCreate = change<PromoCreateArgs>({
  name: 'promotion_create',
  capabilityId: 'marketing.promotions',
  description:
    'Create an AUTOMATIC discount (no code): every shopper whose cart matches gets it at checkout straight away. type percentage = whole percent 0-100; type fixed = EGP off (decimal). scopeProductIds limits it to those products; empty = the whole store. It starts active unless startsAt is in the future.',
  schema: shape<PromoCreateArgs>(
    {
      name: f.str('Promotion name', { max: 150 }),
      nameAr: f.nullable(f.str('Arabic name', { max: 150 })),
      type: f.enum(['percentage', 'fixed']),
      value: f.num('A whole percent (0-100) for percentage, or EGP off for fixed'),
      maxDiscountEgp: f.nullable(f.num('Cap on the discount in EGP; null = no cap')),
      minOrderEgp: f.nullable(f.num('Minimum order total in EGP; null = none')),
      minQuantity: f.nullable(f.int('Minimum quantity in the cart', { min: 1 })),
      firstOrderOnly: f.bool('Only a shopper first order'),
      scopeProductIds: f.list(f.id(), {
        max: 500,
        description: 'Products it applies to; empty = all products',
      }),
      startsAt: f.nullable(f.str('ISO 8601 start; null = now', { max: 40 })),
      expiresAt: f.nullable(f.str('ISO 8601 end; null = never ends', { max: 40 })),
    },
    ['name', 'type', 'value']
  ),
  policy: 'confirm',
  undo: 'compensating', // undo switches the new promotion off (promotion_toggle); there is no assistant delete
  gate: GATE,
  audit: { action: 'promotion.created', resourceType: 'promotion' },
  refs: a => (a.scopeProductIds ?? []).map(id => ({ kind: 'product', id })),
  state: async () => null,
  describe: (_ctx, a): Described => {
    if (a.type === 'percentage' && (!Number.isInteger(a.value) || a.value < 0 || a.value > 100))
      throw new Error('A percentage promotion is a whole number from 0 to 100.');
    parseDate(a.startsAt);
    parseDate(a.expiresAt);
    const scope = a.scopeProductIds?.length
      ? `${a.scopeProductIds.length} product(s)`
      : 'the whole store';
    const scopeAr = a.scopeProductIds?.length ? `${a.scopeProductIds.length} منتج` : 'المتجر كله';
    const amount = a.type === 'percentage' ? `${a.value}%` : `${a.value} EGP`;
    const amountAr = a.type === 'percentage' ? `${a.value}%` : `${a.value} جنيه`;
    return {
      summary: pair(
        `هعمل عرض "${a.name}" بخصم ${amountAr} على ${scopeAr}، والخصم هيظهر لكل العملاء في الدفع علطول.`,
        `I will create the promotion "${a.name}": ${amount} off ${scope}, applied automatically to every matching shopper at checkout, right away.`
      ),
      rows: [
        row('اسم العرض', 'Promotion name', null, a.name),
        row('الخصم', 'Discount', null, amount),
        row(
          'بينطبق على',
          'Applies to',
          null,
          a.scopeProductIds?.length ? a.scopeProductIds : 'all products'
        ),
        row('أقل طلب (جنيه)', 'Minimum order (EGP)', null, a.minOrderEgp ?? null),
        row('أقصى خصم (جنيه)', 'Maximum discount (EGP)', null, a.maxDiscountEgp ?? null),
        row('أول طلب بس', 'First order only', null, a.firstOrderOnly ?? false),
        row('يبدأ في', 'Starts at', null, a.startsAt ?? 'now'),
        row('ينتهي في', 'Ends at', null, a.expiresAt ?? 'never'),
      ],
      affectedCount: 1,
      changesPrice: true,
      touchesCheckout: true,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    const p = await PromotionService.create(ctx.storeId, {
      name: a.name,
      nameAr: a.nameAr,
      type: a.type,
      value: a.type === 'fixed' ? toMinor(a.value) : a.value,
      maxDiscount:
        a.maxDiscountEgp === undefined || a.maxDiscountEgp === null
          ? a.maxDiscountEgp
          : toMinor(a.maxDiscountEgp),
      minOrderAmount:
        a.minOrderEgp === undefined || a.minOrderEgp === null
          ? a.minOrderEgp
          : toMinor(a.minOrderEgp),
      minQuantity: a.minQuantity,
      firstOrderOnly: a.firstOrderOnly,
      scopeProductIds: a.scopeProductIds,
      startsAt: a.startsAt === undefined ? undefined : parseDate(a.startsAt),
      expiresAt: a.expiresAt === undefined ? undefined : parseDate(a.expiresAt),
    });
    return { promotionId: (p as { id: string }).id };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { promotionId?: string } | undefined)?.promotionId;
    return id ? { tool: 'promotion_toggle', args: { promotionId: id, active: false } } : null;
  },
});

// ---- promotion_toggle ------------------------------------------------------------------------------------------------------------------------
type PromoToggleArgs = { promotionId: string; active: boolean };
const promotionToggle = change<PromoToggleArgs>({
  name: 'promotion_toggle',
  capabilityId: 'marketing.promotions',
  description:
    'Switch one automatic promotion on (active=true) or off (active=false). On = every matching shopper gets the discount at checkout immediately; off = it stops immediately. The promotion is kept.',
  schema: shape<PromoToggleArgs>(
    { promotionId: f.id('The promotion id'), active: f.bool('true = on, false = off') },
    ['promotionId', 'active']
  ),
  policy: 'confirm',
  undo: 'reversible',
  gate: GATE,
  audit: { action: 'promotion.toggled', resourceType: 'promotion', resourceId: a => a.promotionId },
  state: async (ctx, a) => {
    const p = await readPromotion(ctx, a.promotionId);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      value: p.value,
      isActive: p.isActive,
      scopeProductIds: p.scopeProductIds,
      startsAt: iso(p.startsAt),
      expiresAt: iso(p.expiresAt),
      updatedAt: iso(p.updatedAt),
    };
  },
  describe: (_ctx, a, st): Described => {
    const s = st as {
      name: string;
      type: string;
      value: number;
      isActive: boolean;
      scopeProductIds: string[];
    };
    const changes = s.isActive !== a.active;
    const amount = s.type === 'percentage' ? `${s.value}%` : `${s.value / 100} EGP`;
    return {
      summary: pair(
        changes
          ? `هـ${a.active ? 'شغّل' : 'وقّف'} العرض "${s.name}" (${amount}) لكل العملاء علطول.`
          : `العرض "${s.name}" أصلاً ${a.active ? 'شغّال' : 'موقوف'}.`,
        changes
          ? `I will switch the promotion "${s.name}" (${amount} off) ${a.active ? 'on' : 'off'} for every matching shopper, immediately.`
          : `The promotion "${s.name}" is already ${a.active ? 'on' : 'off'}.`
      ),
      rows: [
        row('شغّال', 'Active', s.isActive, a.active),
        row('الخصم', 'Discount', amount, amount),
        row(
          'بينطبق على',
          'Applies to',
          s.scopeProductIds.length ? s.scopeProductIds : 'all products',
          null
        ),
      ],
      affectedCount: changes ? 1 : 0,
      changesPrice: true,
      touchesCheckout: true,
      restore: { active: s.isActive },
    };
  },
  run: async (ctx, a, st) => {
    // The route's PATCH flips; asking for the state it already has changes nothing.
    if ((st as { isActive: boolean }).isActive === a.active)
      return { promotionId: a.promotionId, unchanged: true };
    const p = await PromotionService.toggleActive(ctx.storeId, a.promotionId);
    return { promotionId: a.promotionId, isActive: (p as { isActive: boolean }).isActive };
  },
  inverse: (a, restore) => ({
    tool: 'promotion_toggle',
    args: { promotionId: a.promotionId, active: (restore as { active: boolean }).active },
  }),
});

// ---- coupon_delete ---------------------------------------------------------------------------------------------------------------------------
type CouponDeleteArgs = { couponId: string };
const couponDelete = change<CouponDeleteArgs>({
  name: 'coupon_delete',
  capabilityId: 'marketing.coupons',
  description:
    'PERMANENTLY delete one coupon. It cannot be restored (shoppers who hold the code can no longer use it). To just stop a coupon use coupon_toggle instead.',
  schema: shape<CouponDeleteArgs>({ couponId: f.id('The coupon id') }, ['couponId']),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  gate: { roles: ['store_admin'], feature: 'coupons' },
  audit: { action: 'coupon.deleted', resourceType: 'coupon', resourceId: a => a.couponId },
  state: async (ctx, a) => {
    // store-scoped: 404s an id that is not this store's coupon
    const c = (await CouponService.getById(ctx.storeId, a.couponId)) as unknown as {
      id: string;
      code: string;
      name: string;
      type: string;
      value: number;
      isActive: boolean;
      usageCount: number;
      updatedAt: Date;
    };
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      type: c.type,
      value: c.value,
      isActive: c.isActive,
      usageCount: c.usageCount,
      updatedAt: iso(c.updatedAt),
    };
  },
  describe: (_ctx, _a, st): Described => {
    const s = st as {
      code: string;
      name: string;
      type: string;
      value: number;
      isActive: boolean;
      usageCount: number;
    };
    const amount =
      s.type === 'percentage'
        ? `${s.value}%`
        : s.type === 'fixed'
          ? `${s.value / 100} EGP`
          : 'free shipping';
    return {
      summary: pair(
        `همسح الكوبون ${s.code} نهائيًا. مش هينفع ترجّعه، وأي عميل معاه الكود مش هيقدر يستخدمه.`,
        `I will permanently delete coupon ${s.code}. It cannot be restored and shoppers holding the code can no longer use it.`
      ),
      rows: [
        row('الكوبون', 'Coupon', `${s.code} (${s.name}) ${amount}`, null),
        row('شغّال', 'Active', s.isActive, null),
        row('اتستخدم كام مرة', 'Times used', s.usageCount, null),
      ],
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    await CouponService.delete(ctx.storeId, a.couponId);
    return { couponId: a.couponId };
  },
});

export function marketingConfirmTools(): ToolSpec[] {
  return [promotionCreate, promotionToggle, couponDelete];
}
