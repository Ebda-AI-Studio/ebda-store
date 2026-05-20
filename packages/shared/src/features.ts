// Feature Toggle Engine — Feature Registry
import { z } from 'zod';

// All toggleable feature keys (22 — added floating_widget 2026-05-21)
export const FEATURE_KEYS_ARRAY = [
  'coupons',
  'loyalty',
  'returns',
  'reviews',
  'inventory',
  'tax',
  'bulk_operations',
  'customer_wallet',
  'upsell_crosssell',
  'whatsapp',
  'sms',
  'push_notifications',
  'email_campaigns',
  'abandoned_cart',
  'affiliate',
  'marketing_pixels',
  'shipping_carriers',
  'staff_accounts',
  'pwa',
  'seo',
  'search_autocomplete',
  'floating_widget',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS_ARRAY)[number];

export type FeatureCategory = 'commerce' | 'marketing' | 'operations' | 'storefront' | 'engagement';

/**
 * Tier classifies maturity + future pricing/upsell potential. Added
 * 2026-05-21 — orthogonal to category (which is the domain).
 *
 * - 'core' — always recommended for active stores. Safe defaults, no
 *   per-tenant config beyond on/off. Super-admin still gates per-store
 *   for billing-plan reasons but most stores get it.
 * - 'addon' — opt-in extra polish or specialized capability. Often
 *   needs per-tenant config (whatsapp WABA credentials, floating
 *   widget button list, etc.). The "premium" cluster going forward.
 * - 'experimental' — scaffold only / not customer-visible yet. Most
 *   `hidden: true` features fall here.
 */
export type FeatureTier = 'core' | 'addon' | 'experimental';

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  category: FeatureCategory;
  /** Maturity + pricing-cluster axis. Defaults to 'core' when unset. */
  tier?: FeatureTier;
  /**
   * Hide this feature from the admin features list. The key remains
   * valid in the API/DB so existing rows aren't broken, but merchants
   * can no longer toggle it. Used for:
   *   1. Features that aren't actually implemented yet (customer_wallet,
   *      email_campaigns, staff_accounts) — flag them hidden until the
   *      backing code lands.
   *   2. Platform-level features that are universal and have no
   *      per-store impact (seo, search_autocomplete) — toggling them
   *      did nothing, which was misleading.
   * Audit trail: see the features-implementation audit performed
   * 2026-04-29.
   */
  hidden?: boolean;
}

/** Filtered view of the registry: only features that are actually
 *  toggleable from the admin UI. Use this when rendering the features
 *  page or the "Coming soon" gates so dead toggles don't appear. */
export function getVisibleFeatures(): FeatureDefinition[] {
  return Object.values(FEATURE_REGISTRY).filter(f => !f.hidden);
}

export const FEATURE_REGISTRY: Record<FeatureKey, FeatureDefinition> = {
  coupons: {
    key: 'coupons',
    name: 'Coupons',
    nameAr: 'الكوبونات',
    description: 'Create and manage discount coupons for customers.',
    descriptionAr: 'إنشاء وإدارة كوبونات الخصم للعملاء.',
    category: 'commerce',
    tier: 'core',
  },
  loyalty: {
    key: 'loyalty',
    name: 'Loyalty Program',
    nameAr: 'برنامج الولاء',
    description: 'Reward repeat customers with points and redeemable benefits.',
    descriptionAr: 'مكافأة العملاء المتكررين بالنقاط والمزايا القابلة للاسترداد.',
    category: 'commerce',
    tier: 'addon',
  },
  returns: {
    key: 'returns',
    name: 'Returns & Refunds',
    nameAr: 'المرتجعات والمبالغ المستردة',
    description: 'Manage product returns and process customer refunds.',
    descriptionAr: 'إدارة مرتجعات المنتجات ومعالجة استردادات العملاء.',
    category: 'commerce',
    tier: 'core',
  },
  reviews: {
    key: 'reviews',
    name: 'Product Reviews',
    nameAr: 'تقييمات المنتجات',
    description: 'Allow customers to leave ratings and reviews on products.',
    descriptionAr: 'السماح للعملاء بترك التقييمات والمراجعات على المنتجات.',
    category: 'commerce',
    tier: 'core',
  },
  inventory: {
    key: 'inventory',
    name: 'Inventory Management',
    nameAr: 'إدارة المخزون',
    description: 'Track stock levels, set low-stock alerts, and manage warehouses.',
    descriptionAr: 'تتبع مستويات المخزون وتعيين تنبيهات انخفاض المخزون وإدارة المستودعات.',
    category: 'commerce',
    tier: 'core',
  },
  tax: {
    key: 'tax',
    name: 'Tax Management',
    nameAr: 'إدارة الضرائب',
    description: 'Configure tax rates and rules for different regions.',
    descriptionAr: 'تكوين معدلات الضرائب والقواعد للمناطق المختلفة.',
    category: 'commerce',
    tier: 'core',
  },
  bulk_operations: {
    key: 'bulk_operations',
    name: 'Bulk Operations',
    nameAr: 'العمليات الجماعية',
    description: 'Perform bulk edits on products, orders, and customers at once.',
    descriptionAr: 'إجراء تعديلات جماعية على المنتجات والطلبات والعملاء دفعة واحدة.',
    category: 'operations',
    tier: 'core',
  },
  customer_wallet: {
    key: 'customer_wallet',
    name: 'Customer Wallet',
    nameAr: 'محفظة العميل',
    description: 'Enable store credit wallets for customers to store and spend funds.',
    descriptionAr: 'تمكين محافظ رصيد المتجر للعملاء لتخزين الأموال وإنفاقها.',
    category: 'commerce',
    tier: 'experimental',
    hidden: true, // No backing model/service/UI yet — un-hide when shipped.
  },
  upsell_crosssell: {
    key: 'upsell_crosssell',
    name: 'Upsell & Cross-sell',
    nameAr: 'البيع الإضافي والبيع المتقاطع',
    description: 'Suggest related or upgraded products to increase average order value.',
    descriptionAr: 'اقتراح منتجات ذات صلة أو محسّنة لزيادة متوسط قيمة الطلب.',
    category: 'commerce',
    tier: 'addon',
  },
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp Notifications',
    nameAr: 'إشعارات واتساب',
    description:
      'Send order confirmation, shipping, and delivery updates via the Force WhatsApp Business Platform bridge. The merchant connects their WABA on the WhatsApp Notifications page and picks an approved Meta template per event.',
    descriptionAr:
      'إرسال تأكيدات الطلب وتحديثات الشحن والتسليم عبر منصة فورس للواتساب التجاري. يربط التاجر حساب الواتساب التجاري الخاص به في صفحة إشعارات الواتساب ويختار قالب Meta معتمد لكل حدث.',
    category: 'marketing',
    tier: 'addon',
  },
  sms: {
    key: 'sms',
    name: 'SMS Notifications',
    nameAr: 'إشعارات الرسائل القصيرة',
    description: 'Send transactional and promotional SMS messages to customers.',
    descriptionAr: 'إرسال رسائل قصيرة للمعاملات والعروض الترويجية للعملاء.',
    category: 'marketing',
    tier: 'addon',
  },
  push_notifications: {
    key: 'push_notifications',
    name: 'Push Notifications',
    nameAr: 'الإشعارات الفورية',
    description: 'Send browser and mobile push notifications to subscribed customers.',
    descriptionAr: 'إرسال إشعارات فورية للمتصفح والهاتف للعملاء المشتركين.',
    category: 'marketing',
    tier: 'addon',
  },
  email_campaigns: {
    key: 'email_campaigns',
    name: 'Email Campaigns',
    nameAr: 'حملات البريد الإلكتروني',
    description: 'Create and send marketing email campaigns to customer segments.',
    descriptionAr: 'إنشاء وإرسال حملات البريد الإلكتروني التسويقية لشرائح العملاء.',
    category: 'marketing',
    tier: 'experimental',
    hidden: true, // No campaign builder yet — transactional email is separate.
  },
  abandoned_cart: {
    key: 'abandoned_cart',
    name: 'Abandoned Cart Recovery',
    nameAr: 'استرداد عربة التسوق المتروكة',
    description: 'Automatically remind customers who left items in their cart.',
    descriptionAr: 'تذكير العملاء تلقائيًا الذين تركوا عناصر في عربة التسوق الخاصة بهم.',
    category: 'marketing',
    tier: 'core',
  },
  affiliate: {
    key: 'affiliate',
    name: 'Affiliate Program',
    nameAr: 'برنامج التسويق بالعمولة',
    description: 'Let partners earn commissions by referring customers to your store.',
    descriptionAr: 'السماح للشركاء بكسب عمولات من خلال إحالة العملاء إلى متجرك.',
    category: 'marketing',
    tier: 'addon',
  },
  marketing_pixels: {
    key: 'marketing_pixels',
    name: 'Marketing Pixels',
    nameAr: 'بكسلات التسويق',
    description: 'Integrate tracking pixels for Facebook, Google, TikTok, and more.',
    descriptionAr: 'دمج بكسلات التتبع لـ Facebook وGoogle وTikTok والمزيد.',
    category: 'marketing',
    tier: 'core',
  },
  shipping_carriers: {
    key: 'shipping_carriers',
    name: 'Shipping Carriers',
    nameAr: 'شركات الشحن',
    description: 'Connect with shipping carriers for real-time rates and label printing.',
    descriptionAr: 'الاتصال بشركات الشحن للحصول على أسعار فورية وطباعة الملصقات.',
    category: 'operations',
    tier: 'core',
  },
  staff_accounts: {
    key: 'staff_accounts',
    name: 'Staff Accounts',
    nameAr: 'حسابات الموظفين',
    description: 'Add team members with role-based permissions to manage the store.',
    descriptionAr: 'إضافة أعضاء الفريق بأذونات قائمة على الأدوار لإدارة المتجر.',
    category: 'operations',
    tier: 'experimental',
    hidden: true, // No Staff/team-membership model or admin invite UI yet.
  },
  pwa: {
    key: 'pwa',
    name: 'Progressive Web App',
    nameAr: 'تطبيق الويب التقدمي',
    description: 'Enable PWA support so customers can install the store as a mobile app.',
    descriptionAr: 'تمكين دعم PWA حتى يتمكن العملاء من تثبيت المتجر كتطبيق للهاتف المحمول.',
    category: 'storefront',
    tier: 'core',
  },
  seo: {
    key: 'seo',
    name: 'SEO Tools',
    nameAr: 'أدوات تحسين محركات البحث',
    description: 'Advanced SEO settings including meta tags, sitemaps, and structured data.',
    descriptionAr:
      'إعدادات SEO المتقدمة بما في ذلك العلامات الوصفية وخرائط الموقع والبيانات المنظمة.',
    category: 'storefront',
    tier: 'core',
    hidden: true, // Platform-level — every storefront emits SEO metadata regardless of this toggle.
  },
  search_autocomplete: {
    key: 'search_autocomplete',
    name: 'Search Autocomplete',
    nameAr: 'الإكمال التلقائي للبحث',
    description: 'Provide real-time search suggestions as customers type in the search bar.',
    descriptionAr: 'توفير اقتراحات بحث فورية أثناء كتابة العملاء في شريط البحث.',
    category: 'storefront',
    tier: 'core',
    hidden: true, // Platform-level — typeahead is built into every storefront search input.
  },
  floating_widget: {
    key: 'floating_widget',
    name: 'Floating Widget',
    nameAr: 'الزر العائم',
    description:
      'Sticky button group on the storefront — collapses to a single circle, expands to merchant-picked actions (WhatsApp, Instagram, phone, email, background music, custom links). Highly customizable: position, expand direction, per-button colors and labels.',
    descriptionAr:
      'مجموعة أزرار ثابتة على المتجر — تتقلص إلى دائرة واحدة، وتتوسع إلى إجراءات يختارها التاجر (واتساب، إنستغرام، هاتف، بريد إلكتروني، موسيقى الخلفية، روابط مخصصة). قابل للتخصيص بدرجة عالية: الموقع، اتجاه التوسع، الألوان والتسميات لكل زر.',
    category: 'engagement',
    tier: 'addon',
  },
};

// Zod Schemas
export const featureKeySchema = z.enum(FEATURE_KEYS_ARRAY);

// Use generic string keys + manual validation so partial updates work in
// Zod 3.23+ (enum-keyed records require all keys to be present otherwise).
export const featureUpdatesSchema = z
  .record(z.string(), z.boolean())
  .refine(val => Object.keys(val).length > 0, {
    message: 'At least one feature update must be provided.',
  })
  .refine(val => Object.keys(val).every(k => FEATURE_KEYS_ARRAY.includes(k as FeatureKey)), {
    message: 'Unknown feature key in update.',
  });
