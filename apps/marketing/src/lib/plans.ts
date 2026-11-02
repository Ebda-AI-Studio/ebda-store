import {
  LOCKED_PUBLIC_PLANS,
  planIncludesMerchantMcp,
  type PlanLimits,
} from '@ebda/shared/plan-limits';
import { BRAND } from '@ebda/shared/brand';
import type { Locale } from './site';

/**
 * Public plans for the marketing site, derived from the ONE plan catalogue
 * (`LOCKED_PUBLIC_PLANS` in packages/shared/src/schemas/plan-limits.ts, which the
 * billing engine and the locked_pricing migration also read). Only the taglines
 * are marketing copy; every price and limit comes from the catalogue.
 */
export const PRICING_PUBLISHED = true;

export interface PlanPrice {
  /** EGP in piastres (minor units). */
  amountMinor: number;
  period: 'month' | 'year';
}

export type PlanId = 'basic' | 'growth' | 'business';

export interface Plan {
  id: PlanId;
  name: Record<Locale, string>;
  /** null only if pricing is ever pulled again; the UI then shows the "pricing coming soon" placeholder. */
  price: PlanPrice | null;
  annualMinor: number;
  tagline: Record<Locale, string>;
  limits: PlanLimits;
  /** The four headline lines on the plan card, in plain words (the full table shows everything). */
  features: Record<Locale, string[]>;
}

const TAGLINES: Record<PlanId, Record<Locale, string>> = {
  basic: { ar: 'لأول متجر ليك', en: 'For your first store' },
  growth: { ar: 'لما البيع يكتر', en: 'When sales pick up' },
  business: { ar: 'للمتاجر الكبيرة', en: 'For bigger stores' },
};

const n = (v: number) => v.toLocaleString('en-US');

/** "300 طلب في الشهر" / "Unlimited orders" etc., from a plan's limits. */
export function limitText(locale: Locale, key: keyof PlanLimits, l: PlanLimits): string {
  const ar = locale === 'ar';
  switch (key) {
    case 'maxOrdersPerMonth':
      return l.maxOrdersPerMonth === null
        ? ar
          ? 'طلبات من غير حد'
          : 'Unlimited orders'
        : ar
          ? `${n(l.maxOrdersPerMonth)} طلب في الشهر`
          : `${n(l.maxOrdersPerMonth)} orders a month`;
    case 'maxStaff':
      if (l.maxStaff === null) return ar ? 'فريق من غير حد' : 'Unlimited team';
      return ar
        ? l.maxStaff === 2
          ? 'عضوين في الفريق'
          : `${l.maxStaff} ${l.maxStaff <= 10 ? 'أعضاء' : 'عضو'} في الفريق`
        : `${l.maxStaff} team members`;
    case 'maxStores':
      return ar
        ? l.maxStores === 1
          ? 'متجر واحد'
          : `لحد ${l.maxStores} متاجر`
        : l.maxStores === 1
          ? '1 store'
          : `Up to ${l.maxStores} stores`;
    default:
      return '';
  }
}

/**
 * The four lines on a plan card, in plain words (outcomes, not feature flags). Every line is
 * derived from the plan's real limits, so a card never promises what the plan does not include:
 * the third line is the plan's biggest unlock (more stores, cart recovery or unlimited products),
 * the fourth is its top perk (priority support, no badge on your store, or your own domain).
 */
function headline(locale: Locale, l: PlanLimits): string[] {
  const ar = locale === 'ar';
  const third =
    l.maxStores !== 1
      ? limitText(locale, 'maxStores', l)
      : l.abandonedCartAutomation
        ? ar
          ? 'رجّع العملاء اللي سابوا السلة'
          : 'Win back shoppers who left their cart'
        : ar
          ? 'منتجات من غير حد'
          : 'Unlimited products';
  const fourth =
    l.supportTier === 'priority'
      ? ar
        ? 'دعم بالأولوية'
        : 'Priority support'
      : l.brandingRemoval
        ? ar
          ? `شيل علامة ${BRAND.product.nameAr} من متجرك`
          : `Remove the ${BRAND.product.nameEn} badge from your store`
        : ar
          ? 'دومين خاص بيك'
          : 'Your own domain';
  return [
    limitText(locale, 'maxOrdersPerMonth', l),
    limitText(locale, 'maxStaff', l),
    third,
    fourth,
  ];
}

export const PLANS: readonly Plan[] = LOCKED_PUBLIC_PLANS.filter(
  (p): p is (typeof LOCKED_PUBLIC_PLANS)[number] & { code: PlanId } =>
    p.code === 'basic' || p.code === 'growth' || p.code === 'business'
).map(p => ({
  id: p.code,
  name: { ar: p.nameAr, en: p.nameEn },
  price:
    p.priceMonthlyMinor === null ? null : { amountMinor: p.priceMonthlyMinor, period: 'month' },
  annualMinor: p.priceYearlyMinor ?? 0,
  tagline: TAGLINES[p.code],
  limits: p.limits,
  features: { ar: headline('ar', p.limits), en: headline('en', p.limits) },
}));

export const PRICING_PLACEHOLDER: Record<Locale, string> = {
  ar: 'السعر قريب',
  en: 'Pricing coming soon',
};

type Cell = string | boolean;

/** The full comparison table: every public limit, per plan, in the catalogue's order. */
export function comparisonRows(locale: Locale): { label: string; cells: Cell[] }[] {
  const ar = locale === 'ar';
  const tiers = {
    basic: ar ? 'أساسية' : 'Basic',
    standard: ar ? 'قياسية' : 'Standard',
    advanced: ar ? 'متقدمة' : 'Advanced',
    email: ar ? 'إيميل' : 'Email',
    chat: ar ? 'شات' : 'Chat',
    priority: ar ? 'أولوية' : 'Priority',
  } as const;
  const egp = (minor: number) => (ar ? `${n(minor / 100)} ج.م` : `EGP ${n(minor / 100)}`);
  const unlimited = ar ? 'من غير حد' : 'Unlimited';
  const num = (v: number | null) => (v === null ? unlimited : n(v));
  const row = (label: string, f: (p: Plan) => Cell) => ({ label, cells: PLANS.map(f) });
  return [
    row(ar ? 'السعر الشهري' : 'Monthly price', p => (p.price ? egp(p.price.amountMinor) : '')),
    row(ar ? 'السعر السنوي (خصم 25%)' : 'Yearly price (25% off)', p => egp(p.annualMinor)),
    row(
      ar ? 'عمولة على الطلبات' : 'Commission on orders',
      p => `${p.limits.platformFeeBps / 100}%`
    ),
    row(ar ? 'الطلبات في الشهر' : 'Orders a month', p => num(p.limits.maxOrdersPerMonth)),
    row(ar ? 'المنتجات' : 'Products', p => num(p.limits.maxProducts)),
    row(ar ? 'أعضاء الفريق' : 'Team members', p => num(p.limits.maxStaff)),
    row(ar ? 'المتاجر' : 'Stores', p => num(p.limits.maxStores)),
    row(ar ? 'دومين خاص' : 'Custom domain', p => p.limits.customDomain),
    row(
      ar ? 'رجّع العملاء اللي سابوا السلة' : 'Win back shoppers who left their cart',
      p => p.limits.abandonedCartAutomation
    ),
    // WA-PKG-1: the Ebda Chat Store package comes with the plan whose limits say so (Business, in the catalogue).
    row(
      ar
        ? `حزمة المتجر من ${BRAND.productWhatsapp.nameAr}`
        : `${BRAND.productWhatsapp.nameEn} Store package`,
      p => p.limits.whatsappAutomation
    ),
    row(
      ar
        ? `شيل علامة ${BRAND.product.nameAr} من متجرك`
        : `Remove the ${BRAND.product.nameEn} badge from your store`,
      p => p.limits.brandingRemoval
    ),
    row(ar ? 'شغّل متجرك من مساعد ذكاء اصطناعي' : 'Run your store from an AI assistant', p =>
      planIncludesMerchantMcp(p.id, p.limits)
    ),
    // Not a plan limit: every plan includes it (Ahmad 2026-10-07; R-EBDA-COPY-12).
    row(ar ? 'موديلات 3D للمنتجات' : '3D product models', () => true),
    row(ar ? 'التحليلات' : 'Analytics', p => tiers[p.limits.analyticsTier]),
    row(ar ? 'الدعم' : 'Support', p => tiers[p.limits.supportTier]),
  ];
}
