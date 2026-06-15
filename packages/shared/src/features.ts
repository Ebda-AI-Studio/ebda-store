// Feature Toggle Engine — Feature Registry
import { z } from 'zod';

// All toggleable feature keys.
// 2026-05-21: 22 features (added floating_widget).
// 2026-05-27: +14 sub-features (inventory.* + accounting.*) for the 3-tier
//   plan system. The parent `inventory` flag stays for backwards
//   compatibility but new code paths read the granular sub-keys via
//   PLAN_BASELINE in `./plan-baselines.ts`.
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
  // Inventory sub-features (2026-05-27)
  'inventory.basic',
  'inventory.stock_alerts',
  'inventory.backorder',
  'inventory.multi_warehouse',
  'inventory.barcode',
  'inventory.purchase_orders',
  'inventory.bulk_adjustments',
  // Accounting sub-features (2026-05-27)
  'accounting.basic',
  'accounting.expenses',
  'accounting.invoicing',
  'accounting.tax_reports',
  'accounting.multi_currency',
  'accounting.profit_anomaly',
  'accounting.bank_reconcile',
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
      'Send order confirmation, shipping, and delivery updates via the Force AI WhatsApp Business Platform bridge. The merchant connects their WABA on the WhatsApp Notifications page and picks an approved Meta template per event.',
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
    description:
      'Marketing pixels (Meta/Facebook, Google, TikTok) with server-side Conversions API (CAPI) for Meta and TikTok — fires on every order even when browser ad-blockers suppress the client-side pixel.',
    descriptionAr:
      'بكسلات التسويق (Meta/Facebook وGoogle وTikTok) مع واجهة برمجة تحويلات من جانب الخادم (CAPI) لـ Meta وTikTok — تُطلَق مع كل طلب حتى عند حجب البكسل من قِبل أدوات منع الإعلانات.',
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
  // -------- Inventory sub-features (2026-05-27) --------
  'inventory.basic': {
    key: 'inventory.basic',
    name: 'Inventory — Stock Tracking',
    nameAr: 'المخزون — تتبع المخزون',
    description:
      'Per-product stock counts, low-stock badge on storefront, manual stock adjustment in admin.',
    descriptionAr:
      'عدد المخزون لكل منتج، شارة المخزون المنخفض في المتجر، وتعديل المخزون يدوياً من لوحة التحكم.',
    category: 'operations',
    tier: 'core',
  },
  'inventory.stock_alerts': {
    key: 'inventory.stock_alerts',
    name: 'Inventory — Low-Stock Alerts',
    nameAr: 'المخزون — تنبيهات المخزون المنخفض',
    description:
      'Auto-email the merchant when a product drops below its per-product low-stock threshold.',
    descriptionAr: 'إرسال بريد إلكتروني تلقائي للتاجر عند انخفاض منتج عن حد المخزون المحدد له.',
    category: 'operations',
    tier: 'addon',
  },
  'inventory.backorder': {
    key: 'inventory.backorder',
    name: 'Inventory — Backorder',
    nameAr: 'المخزون — الطلب المسبق',
    description:
      'Accept customer orders when a product is out of stock; queue for fulfillment when restocked.',
    descriptionAr:
      'قبول طلبات العملاء عند نفاد المنتج وحفظها في قائمة انتظار التنفيذ عند توفر المخزون.',
    category: 'operations',
    tier: 'addon',
  },
  'inventory.multi_warehouse': {
    key: 'inventory.multi_warehouse',
    name: 'Inventory — Multi-Warehouse',
    nameAr: 'المخزون — مستودعات متعددة',
    description: 'Track stock counts per warehouse and route orders by proximity or rule.',
    descriptionAr: 'تتبع المخزون لكل مستودع وتوجيه الطلبات حسب القرب أو حسب قاعدة محددة.',
    category: 'operations',
    tier: 'addon',
  },
  'inventory.barcode': {
    key: 'inventory.barcode',
    name: 'Inventory — Barcode Scanning',
    nameAr: 'المخزون — مسح الباركود',
    description:
      'Scan barcodes from mobile to receive stock, pick orders, and audit inventory counts.',
    descriptionAr: 'مسح الباركود من الجوال لاستلام المخزون وتجهيز الطلبات ومراجعة الكميات.',
    category: 'operations',
    tier: 'addon',
  },
  'inventory.purchase_orders': {
    key: 'inventory.purchase_orders',
    name: 'Inventory — Purchase Orders',
    nameAr: 'المخزون — أوامر الشراء',
    description:
      'Supplier purchase-order workflow with cost capture, receive-against-PO, and supplier ledger.',
    descriptionAr:
      'سير عمل أوامر الشراء من المورّدين مع تسجيل التكلفة والاستلام مقابل الأمر ودفتر المورّد.',
    category: 'operations',
    tier: 'addon',
  },
  'inventory.bulk_adjustments': {
    key: 'inventory.bulk_adjustments',
    name: 'Inventory — Bulk Adjustments',
    nameAr: 'المخزون — التعديلات المجمّعة',
    description: 'CSV/Excel import for stock reconciliation across hundreds of products at once.',
    descriptionAr: 'استيراد من CSV/Excel لمطابقة المخزون عبر مئات المنتجات دفعةً واحدة.',
    category: 'operations',
    tier: 'addon',
  },
  // -------- Accounting sub-features (2026-05-27) --------
  'accounting.basic': {
    key: 'accounting.basic',
    name: 'Accounting — Journal + P&L',
    nameAr: 'المحاسبة — دفتر اليومية والربح والخسارة',
    description:
      'Double-entry journal with auto-posted sales/refund/cost entries and a simple Profit & Loss report.',
    descriptionAr:
      'دفتر يومية بقيد مزدوج مع قيود مبيعات/مرتجعات/تكلفة تلقائية وتقرير ربح وخسارة مبسط.',
    category: 'operations',
    tier: 'core',
  },
  'accounting.expenses': {
    key: 'accounting.expenses',
    name: 'Accounting — Expense Tracking',
    nameAr: 'المحاسبة — تتبع المصروفات',
    description:
      'Categorized expense entry with receipts attachment and monthly summary by category.',
    descriptionAr: 'تسجيل المصروفات مصنّفاً مع إرفاق الفواتير وملخص شهري حسب الفئة.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.invoicing': {
    key: 'accounting.invoicing',
    name: 'Accounting — Invoicing',
    nameAr: 'المحاسبة — إصدار الفواتير',
    description:
      'Kuwait-compliant invoice generation with tax line, bilingual layout, and PDF export.',
    descriptionAr:
      'إصدار فواتير متوافقة مع متطلبات الكويت تتضمّن خانة الضريبة وتصميماً ثنائي اللغة وتصدير PDF.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.tax_reports': {
    key: 'accounting.tax_reports',
    name: 'Accounting — Tax Reports',
    nameAr: 'المحاسبة — التقارير الضريبية',
    description: 'VAT/sales-tax export per reporting period with full transaction-level breakdown.',
    descriptionAr: 'تصدير ضريبة القيمة المضافة/المبيعات لكل دورة مع تفصيل كامل على مستوى المعاملة.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.multi_currency': {
    key: 'accounting.multi_currency',
    name: 'Accounting — Multi-Currency',
    nameAr: 'المحاسبة — تعدد العملات',
    description:
      'Track non-KWD transactions with FX rates and automatic KWD conversion at the book-keeping level.',
    descriptionAr:
      'تتبع المعاملات بعملات غير الدينار مع أسعار صرف وتحويل تلقائي إلى الدينار على مستوى الدفاتر.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.profit_anomaly': {
    key: 'accounting.profit_anomaly',
    name: 'Accounting — Profit Anomaly Watch',
    nameAr: 'المحاسبة — مراقبة شذوذ الأرباح',
    description:
      'Runs a daily AI scan of margins (06:30 KWT); flags unusual margin drops and cost-volume spikes vs a 28-day rolling baseline.',
    descriptionAr:
      'فحص يومي بالذكاء الاصطناعي للهوامش (06:30 بتوقيت الكويت)؛ ينبّه عند هبوط الهامش أو ارتفاع حجم التكلفة بشكل غير مألوف مقارنةً بمتوسط 28 يومًا.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.bank_reconcile': {
    key: 'accounting.bank_reconcile',
    name: 'Accounting — Bank Reconciliation',
    nameAr: 'المحاسبة — مطابقة كشف البنك',
    description:
      'Bank statement import (CSV/OFX) with automated match against the ledger and manual override.',
    descriptionAr:
      'استيراد كشف البنك (CSV/OFX) مع مطابقة آلية بدفتر اليومية وإمكانية التصحيح اليدوي.',
    category: 'operations',
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
