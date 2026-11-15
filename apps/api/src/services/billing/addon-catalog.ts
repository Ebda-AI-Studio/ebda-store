/**
 * What a merchant can buy outside the plan (SELF-SERVICE A8 + A9). One catalog, integer piastres.
 *
 * Ruling ADDON-1 - prices are placeholders pending Ahmad's number: EGP 99 per add-on per 30 days, AI packs EGP 49 / 149.
 * Change them HERE only (the preview, the ledger row and the screen all read this file). Cost if wrong: a merchant is
 * quoted and charged the wrong amount; the quote is shown and confirmed before any charge, so the damage is bounded
 * to one wrong-price purchase that can be refunded from the ledger.
 *
 * A purchase is a `billing_events` row of type `upgrade` whose `planCode` is `addon:<sku>`. Ruling ADDON-2 - no new
 * type or table: the type CHECK exists in Postgres AND in the D1 platform schema and a new store-scoped table touches
 * the D1 split, erasure and tenant-guard snapshots. The prefix keeps every plan reader safe: `plans` has no such code,
 * so each of them fails closed on it.
 */
import type { FeatureKey } from '@ebda/shared';

export const ADDON_TERM_DAYS = 30;
export const ADDON_PLAN_PREFIX = 'addon:';
/** Append-only renewal intent rows (ADDON-RENEW-1): zero-amount `upgrade` rows that never start with `addon:`. */
export const ADDON_CANCEL_PREFIX = 'addon-cancel:';
export const ADDON_RESUME_PREFIX = 'addon-resume:';
export const ADDON_MARKER_PREFIX = 'addon-';

type AddonKind = 'feature' | 'ai_topup';
export interface AddonItem {
  sku: string;
  kind: AddonKind;
  featureKey?: FeatureKey;
  /** Extra AI requests per day for the term (ai_topup only). */
  aiExtraRequests?: number;
  priceMinor: number;
  nameEn: string;
  nameAr: string;
  /** What it does for the merchant, one or two sentences (Egyptian Arabic, full sentences). */
  descEn: string;
  descAr: string;
  /** Preview image under `apps/admin/public/addons/` (served at `/addons/<file>`); the card renders without one. */
  previewImage?: string;
}

const FEATURE_PRICE_MINOR = 9900;
const feature = (
  key: FeatureKey,
  nameEn: string,
  nameAr: string,
  descEn: string,
  descAr: string
): AddonItem => ({
  sku: `feature:${key}`,
  kind: 'feature',
  featureKey: key,
  priceMinor: FEATURE_PRICE_MINOR,
  nameEn,
  nameAr,
  descEn,
  descAr,
});

const ITEMS: AddonItem[] = [
  feature(
    'floating_widget',
    'Floating Widget',
    'الزر العائم',
    'A button that floats on every page of your store so shoppers can reach WhatsApp, a call or a link in one tap.',
    'زر بيطفو على كل صفحات متجرك، فالعميل يوصلك على واتساب أو يكلمك أو يفتح لينك بضغطة واحدة.'
  ),
  feature(
    'customer_wallet_checkout',
    'Pay with Wallet at Checkout',
    'الدفع من المحفظة عند الشراء',
    'Customers spend the balance in their wallet when they check out, so refunds and credits turn into repeat orders.',
    'العميل يدفع من رصيد محفظته وهو بيكمل الطلب، فالمبالغ المرجّعة والرصيد بيرجعوا لك طلبات تانية.'
  ),
  feature(
    'loyalty',
    'Loyalty Program',
    'برنامج الولاء',
    'Customers earn points on every order and redeem them for discounts, which brings them back to buy again.',
    'العميل بيكسب نقاط على كل طلب ويستبدلها بخصم، فبيرجع يشتري تاني.'
  ),
  feature(
    'upsell_crosssell',
    'Upsell & Cross-sell',
    'البيع الإضافي',
    'Suggest related products on the product page and in the cart to raise the value of each order.',
    'اقترح منتجات مكمّلة في صفحة المنتج وفي السلة عشان قيمة كل طلب تزيد.'
  ),
  feature(
    'push_notifications',
    'Push Notifications',
    'الإشعارات',
    'Send a notification to the phones and browsers of shoppers who allowed it, for offers and order updates.',
    'ابعت إشعار على موبايلات ومتصفحات العملاء اللي وافقوا عليه، للعروض وتحديثات الطلبات.'
  ),
  feature(
    'affiliate',
    'Affiliate Program',
    'برنامج التسويق بالعمولة',
    'Let partners promote your store with their own link and earn a commission on the orders they bring.',
    'خلّي شركاءك يسوّقوا لمتجرك بلينك خاص بيهم ويكسبوا عمولة على الطلبات اللي بيجيبوها.'
  ),
  {
    sku: 'ai:topup_300',
    kind: 'ai_topup',
    aiExtraRequests: 300,
    priceMinor: 4900,
    nameEn: '+300 AI requests a day',
    nameAr: '300 طلب ذكاء اصطناعي زيادة كل يوم',
    descEn:
      'Raises your store daily AI limit by 300 requests for 30 days. Use it when you run out before the day ends.',
    descAr:
      'بيزوّد حد الذكاء الاصطناعي اليومي لمتجرك 300 طلب لمدة 30 يوم. اشتريه لو بيخلص منك قبل آخر اليوم.',
  },
  {
    sku: 'ai:topup_1000',
    kind: 'ai_topup',
    aiExtraRequests: 1000,
    priceMinor: 14900,
    nameEn: '+1000 AI requests a day',
    nameAr: '1000 طلب ذكاء اصطناعي زيادة كل يوم',
    descEn:
      'Raises your store daily AI limit by 1000 requests for 30 days, for stores that use AI on many products every day.',
    descAr:
      'بيزوّد حد الذكاء الاصطناعي اليومي لمتجرك 1000 طلب لمدة 30 يوم، للمتاجر اللي بتستخدم الذكاء الاصطناعي على منتجات كتير كل يوم.',
  },
];

export const ADDON_CATALOG: Record<string, AddonItem> = Object.fromEntries(
  ITEMS.map(i => [i.sku, i])
);

/** Feature add-ons renew every term on the saved card; AI packs never do. */
export const renewsEachTerm = (item: AddonItem): boolean => item.kind === 'feature';

export const planCodeOfSku = (sku: string): string => `${ADDON_PLAN_PREFIX}${sku}`;

/** The catalog sku a ledger `planCode` names, or null (a real plan, or an add-on that is no longer sold). */
export function skuOfPlanCode(planCode: string | null | undefined): string | null {
  if (!planCode?.startsWith(ADDON_PLAN_PREFIX)) return null;
  const sku = planCode.slice(ADDON_PLAN_PREFIX.length);
  return ADDON_CATALOG[sku] ? sku : null;
}
