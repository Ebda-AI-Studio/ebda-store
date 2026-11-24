// Feature Toggle Engine — Feature Registry
import { z } from 'zod/v3';

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
  // Customer wallet — spending the balance at checkout (2026-09-25). A SECOND,
  // separate key from `customer_wallet` because it is the only part of the
  // wallet that touches the payment amount of an order. NOT in any plan
  // baseline: OFF for every store until a super-admin turns it on, and it is
  // inert unless `customer_wallet` is ALSO on. See
  // docs/plans/done/2026-09-25-customer-wallet.md.
  'customer_wallet_checkout',
  'upsell_crosssell',
  'whatsapp',
  'sms',
  'push_notifications',
  'email_campaigns',
  'abandoned_cart',
  'affiliate',
  'marketing_pixels',
  'agent_feed',
  // Product feeds for Google Merchant Center, Meta Commerce Manager and TikTok Catalog (2026-11-14, Ruling FEEDS-1).
  'product_feeds',
  'agent_checkout',
  'answer_engine_insights',
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
  // Payment-gateway abandonment capture (2026-06-22) — Enterprise only.
  // Gates the Inngest sweep that stamps paymentGatewayAbandonedAt and the
  // admin retargeting UI at /stores/:id/payment-abandonments.
  'payment_abandonment',
  // Product Bundles (2026-09-06) — sold per store, NOT part of any plan
  // baseline (see plan-baselines.ts). A merchant only gets it via an
  // explicit super-admin StoreFeature override.
  'bundles',
  // Egypt ETA e-receipt connector (2026-10-26, Ruling ETA-1). Per-store, OFF by default, in NO plan
  // baseline: a super-admin StoreFeature override turns it on for a VAT-registered merchant.
  'eta_ereceipt',
  // Customer Intelligence hints (2026-10-29, CI-3, Ruling CI-10). Advise-never-block hints from the
  // store's own outcomes and the opted-in cohort: COD risk band on an order, a courier suggestion when
  // booking, a COD-amount suggestion card. In NO plan baseline: OFF for every store until the merchant
  // (or a super-admin) turns it on; turning it off is the merchant's "turn off hints" switch.
  'customer_intelligence',
  // MCP agent-write ESCAPE HATCH (2026-09-09, Ruling M2). NOT part of any
  // plan baseline, so it is OFF for every store and the default posture is
  // ENFORCEMENT ON: the MCP write tools (add_to_cart, place_order) require
  // the store's `X-Agent-Key` credential. Turning this key ON for one store
  // DISABLES that requirement for that store — it is the per-store, no-deploy
  // rollback lever, never the switch that turns the protection on.
  'agent_checkout_open_writes',
  // MERCHANT-ADMIN MCP surface (2026-09-11). Full store CRUD over MCP, so a
  // merchant can operate their store from Claude Code instead of the admin
  // dashboard. In NO PLAN_BASELINE; since 2026-10-14 it is decided by the PLAN
  // (Growth + Business, `planIncludesMerchantMcp`) via FeatureService's plan
  // layer, a super-admin StoreFeature override wins both ways, and the endpoint
  // 404s while off — fail closed for a surface that can change anything.
  'merchant_mcp',
  // Merchant MCP WRITE tools (2026-10-10, Ahmad; binding decision 4). A second,
  // narrower gate UNDER `merchant_mcp` (the whole surface; both Growth +
  // Business via `planIncludesMerchantMcp`, NOT `apiAccess`): mutating a store from an LLM transcript is a bigger blast
  // radius than reading one. Decided by the PLAN (Growth + Business — see
  // `getAutomationFlags().mcpAccess`) via FeatureService's plan layer, in NO
  // PLAN_BASELINE; a super-admin StoreFeature override wins both ways. The
  // merchant's own per-store switch is `store.settings.mcpWriteEnabled`
  // (default on). See apps/api/src/mcp/merchant-write.ts.
  'merchant_mcp_write',
  // Hide the "Powered by Ebda" storefront footer (2026-10-07). Decided by the
  // PLAN (`brandingRemoval` limit: Growth + Business) via FeatureService's plan
  // layer — in NO PLAN_BASELINE; a super-admin StoreFeature override still wins.
  'remove_branding',
  // B2B wholesale pricing (2026-10-21, Ruling B2B-1; docs/plans/done/2026-10-21-b2b-wholesale.md).
  // Decided by the PLAN (`wholesalePricing` limit: Business + comped) via FeatureService's plan
  // layer, in NO PLAN_BASELINE; a super-admin StoreFeature override wins both ways.
  'b2b.wholesale',
  // Product 3D models + AR on the PDP (2026-10-07). Included in EVERY plan's
  // baseline (Ahmad 2026-10-07, Ruling R-EBDA-3D-2 — no plan gate). A key at all
  // only so a super-admin StoreFeature override can switch it off per store.
  'product_3d',
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
   *   1. Features that aren't actually implemented yet — flag them hidden
   *      until the backing code lands. (customer_wallet and email_campaigns
   *      were both un-hidden 2026-09-25 when they shipped.)
   *   2. Platform-level features that are universal and have no
   *      per-store impact (seo, search_autocomplete) — toggling them
   *      did nothing, which was misleading.
   * Audit trail: see the features-implementation audit performed
   * 2026-04-29.
   */
  hidden?: boolean;
  /**
   * With `hidden: true`: still show this feature (with a "hidden from
   * merchants" badge) in the SUPER-ADMIN per-store FeatureMatrix, so a
   * super-admin can switch it per store. Explicit allowlist: platform-level
   * hidden features (seo, search_autocomplete) have no per-store meaning and
   * stay out. Merchant lists keep using getVisibleFeatures().
   */
  superAdminToggleable?: boolean;
}

/** Filtered view of the registry: only features that are actually
 *  toggleable from the admin UI. Use this when rendering the features
 *  page or the "Coming soon" gates so dead toggles don't appear. */
/** Super-admin matrix view: merchant-visible features plus the hidden ones
 *  explicitly marked `superAdminToggleable`. */
export function getSuperAdminFeatures(): FeatureDefinition[] {
  return Object.values(FEATURE_REGISTRY).filter(f => !f.hidden || f.superAdminToggleable);
}

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
    // F2 (live QA 2026-11-17): the legacy PARENT flag gates nothing. It is in no plan baseline and no route, page or
    // nav item reads it (inventory.routes.ts gates each handler on its `inventory.*` sub-key). Shown in the matrix it
    // said "not included" while every inventory page worked. Hidden; the `inventory.*` sub-features are the gates.
    hidden: true,
  },
  tax: {
    key: 'tax',
    name: 'Tax Management',
    nameAr: 'إدارة الضرائب',
    // Issue 2358, ruling TAX-1a: the tax on/off switch and the rate list are
    // NOT gated by this key — collection is a legal obligation, available on
    // every plan. The key is reserved for advanced tax features (region-scoped
    // or compound rates); none is built, so it currently gates nothing.
    description:
      'Reserved for advanced tax features (region or compound rates). Basic tax settings and rates are available on every plan.',
    descriptionAr:
      'مخصّص لميزات الضريبة المتقدمة (معدلات حسب المنطقة أو مركّبة). إعدادات الضريبة ومعدلاتها الأساسية متاحة في كل الباقات.',
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
    description:
      'Store credit wallets: refunds as store credit land in the customer wallet, merchants can adjust balances, and customers see their balance in their account.',
    descriptionAr:
      'محافظ رصيد المتجر: تُضاف المبالغ المستردة كرصيد متجر إلى محفظة العميل، ويمكن للتاجر تعديل الأرصدة، ويرى العميل رصيده في حسابه.',
    category: 'commerce',
    tier: 'addon',
    // Un-hidden 2026-09-25 (D1). In the Growth + Business baselines since 2026-10-29 (Ruling W-8);
    // a super-admin override still wins both ways.
  },
  customer_wallet_checkout: {
    key: 'customer_wallet_checkout',
    name: 'Pay with Wallet at Checkout',
    nameAr: 'الدفع من المحفظة عند الشراء',
    description:
      'Lets signed-in customers pay part or all of an order from their wallet balance. Requires Customer Wallet. Unavailable while accounting is enabled.',
    descriptionAr:
      'يتيح للعملاء المسجلين دفع جزء من الطلب أو كامله من رصيد المحفظة. يتطلب محفظة العميل. غير متاح أثناء تفعيل المحاسبة.',
    category: 'commerce',
    tier: 'addon',
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
    name: 'WhatsApp Order Updates',
    nameAr: 'تحديثات الطلب على واتساب',
    description:
      'Order updates reach customers on WhatsApp through Ebda Chat once the store is linked to it: order confirmation, shipping updates and a paid notice. Ebda Chat uses its own message templates, so the merchant does not connect a WhatsApp Business account here or pick templates per event.',
    descriptionAr:
      'تحديثات الطلب بتوصل لعملائك على واتساب من خلال ابدأ شات أول ما تربط المتجر بيه: تأكيد الطلب وتحديثات الشحن وإشعار الدفع. ابدأ شات بيستخدم قوالب رسائله الخاصة، فمش محتاج تربط حساب واتساب للأعمال من هنا ولا تختار قالب لكل حدث.',
    category: 'marketing',
    tier: 'addon',
    // hidden (case 1: not launched). The key gates the separate Ebda Chat product
    // (wa.ebda.app). The legacy in-Store WhatsApp API bridge was deleted (Ruling
    // WA-LEGACY-1); the key stays for the Store-side contract. In NO plan
    // baseline, so no store resolves it ON, and out of the feature matrix. A
    // super-admin StoreFeature `whatsapp` override (API) enables one store.
    hidden: true,
    superAdminToggleable: true, // switchable per store from the super-admin FeatureMatrix
  },
  sms: {
    key: 'sms',
    name: 'SMS Notifications',
    nameAr: 'إشعارات الرسائل القصيرة',
    description:
      'Send transactional SMS messages to customers (order confirmed, shipped, delivered, cancelled, refunded) through our SMS gateway. Customers who tick the opt-in checkbox at checkout also receive promotional SMS (cart reminders, back-in-stock alerts).',
    descriptionAr:
      'إرسال رسائل قصيرة للمعاملات (تأكيد الطلب، الشحن، التسليم، الإلغاء، الاسترداد) عبر بوابة الرسائل. العملاء الذين يوافقون على استقبال الرسائل عند الدفع يتلقون أيضاً رسائل ترويجية (تذكير بالسلة، إشعار توفر المنتج).',
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
    description:
      'Write bilingual marketing emails and send them to newsletter subscribers who opted in.',
    descriptionAr: 'كتابة رسائل تسويقية بالعربية والإنجليزية وإرسالها لمشتركي النشرة الذين وافقوا.',
    category: 'marketing',
    tier: 'experimental',
    // Un-hidden 2026-09-25 (D2): the campaign builder shipped. In the Growth + Business
    // baselines since 2026-10-21 (plan-baselines.ts PROFESSIONAL_ADDITIONS); Basic resolves OFF
    // unless a super-admin StoreFeature override turns it on.
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
  agent_feed: {
    key: 'agent_feed',
    name: 'AI Product Feed',
    nameAr: 'خلاصة المنتجات للذكاء الاصطناعي',
    description:
      'Publishes a machine-readable product feed at /feeds/products.json so AI assistants and shopping agents (ChatGPT, Perplexity, and agent crawlers) can read, cite, and recommend the store’s products. Follows the OpenAI Product Feed field conventions.',
    descriptionAr:
      'ينشر خلاصة منتجات قابلة للقراءة آليًا على /feeds/products.json حتى تتمكن مساعدات الذكاء الاصطناعي ووكلاء التسوق (ChatGPT وPerplexity وزواحف الوكلاء) من قراءة منتجات المتجر والاستشهاد بها والتوصية بها. تتبع اصطلاحات حقول خلاصة منتجات OpenAI.',
    category: 'marketing',
    tier: 'addon',
  },
  product_feeds: {
    key: 'product_feeds',
    name: 'Product Feeds (Google, Meta, TikTok)',
    nameAr: 'خلاصات المنتجات (جوجل وميتا وتيك توك)',
    description:
      'Publishes the full product catalogue, variants included, as feeds for Google Merchant Center (Shopping and free listings), Meta Commerce Manager (Facebook and Instagram catalogue ads) and TikTok Catalog Manager, at /feeds/google.xml, /feeds/meta.xml and /feeds/tiktok.csv, with a feed health report in the admin.',
    descriptionAr:
      'ينشر كتالوج المنتجات كاملًا بما فيه الأنواع (المقاسات والألوان) كخلاصات لـ Google Merchant Center (إعلانات الشراء والقوائم المجانية) وMeta Commerce Manager (إعلانات الكتالوج على فيسبوك وإنستجرام) وTikTok Catalog Manager، على /feeds/google.xml و/feeds/meta.xml و/feeds/tiktok.csv، مع تقرير صحة الخلاصة في لوحة التحكم.',
    category: 'marketing',
    tier: 'core',
  },
  agent_checkout: {
    key: 'agent_checkout',
    name: 'AI Agent Checkout (MCP)',
    nameAr: 'الشراء عبر وكلاء الذكاء الاصطناعي',
    description:
      'Exposes a store-scoped MCP server so AI shopping agents (Claude, ChatGPT, and agentic assistants) can search the catalog, build a cart, and place a guest order. COD completes autonomously; online payment is handed back as a hosted checkout link.',
    descriptionAr:
      'يوفّر خادم MCP خاصاً بالمتجر لتمكين وكلاء الذكاء الاصطناعي من البحث في المنتجات وإنشاء سلة وإتمام الطلب. الدفع عند الاستلام يكتمل تلقائياً، والدفع الإلكتروني يُعاد كرابط دفع.',
    category: 'marketing',
    tier: 'addon',
  },
  answer_engine_insights: {
    key: 'answer_engine_insights',
    name: 'Answer-Engine Insights',
    nameAr: 'رؤى محركات الإجابة',
    description:
      'Measures whether AI answer engines (ChatGPT, Perplexity, Google AI Overviews) surface and cite the store when shoppers ask about its products — tracking answer-engine visibility alongside traditional search.',
    descriptionAr:
      'يقيس ما إذا كانت محركات الإجابة بالذكاء الاصطناعي (ChatGPT وPerplexity ونظرة Google العامة بالذكاء الاصطناعي) تعرض المتجر وتستشهد به عندما يسأل المتسوقون عن منتجاته — لتتبع ظهور المتجر في محركات الإجابة إلى جانب البحث التقليدي.',
    category: 'marketing',
    tier: 'addon',
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
    tier: 'core',
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
    description:
      'Track stock counts per warehouse location and route orders to the closest or highest-priority warehouse that has sufficient stock. ' +
      'Includes per-warehouse stock views, delta adjustments with audit trail, and a cross-warehouse order-routing API (priority rule or nearest-warehouse rule). ' +
      'Existing Product.inventory aggregates are kept in sync automatically — single-warehouse stores are unaffected when the flag is off.',
    descriptionAr:
      'تتبع مستويات المخزون لكل مستودع وتوجيه الطلبات تلقائياً إلى أقرب مستودع أو الأعلى أولوية الذي يحتوي على مخزون كافٍ. ' +
      'يشمل عرض المخزون لكل مستودع وتعديلات بمسار تدقيق، وواجهة برمجية لتوجيه الطلبات (قاعدة الأولوية أو قاعدة القرب الجغرافي). ' +
      'تظل إجماليات مخزون المنتجات محدّثة تلقائياً — المتاجر ذات المستودع الواحد لا تتأثر عند إيقاف الميزة.',
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
    description:
      'CSV import for stock reconciliation across hundreds of products at once. ' +
      'Upload a CSV with SKU or Barcode + New Quantity (absolute) or Delta (signed +/−). ' +
      'Arabic column headers are supported. Rows are resolved to products, previewed before ' +
      'apply, and posted as a single auditable StockAdjustment with a GL journal entry.',
    descriptionAr:
      'استيراد CSV لمطابقة المخزون عبر مئات المنتجات دفعةً واحدة. ' +
      'ارفع ملف CSV يحتوي على رمز المنتج أو الباركود مع الكمية الجديدة (مطلقة) أو التغيير (موجب/سالب). ' +
      'تُدعم رؤوس الأعمدة العربية. يُحوَّل كل صف إلى تسوية مخزون موحّدة مع قيد دفتر يومية.',
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
      'Egypt-compliant invoice generation with tax line, bilingual layout, and PDF export.',
    descriptionAr:
      'إصدار فواتير متوافقة مع متطلبات مصر تتضمّن خانة الضريبة وتصميماً ثنائي اللغة وتصدير PDF.',
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
      'Track non-EGP transactions with FX rates and automatic EGP conversion at the book-keeping level.',
    descriptionAr:
      'تتبع المعاملات بعملات غير الجنيه مع أسعار صرف وتحويل تلقائي إلى الجنيه على مستوى الدفاتر.',
    category: 'operations',
    tier: 'addon',
  },
  'accounting.profit_anomaly': {
    key: 'accounting.profit_anomaly',
    name: 'Accounting — Profit Anomaly Watch',
    nameAr: 'المحاسبة — مراقبة شذوذ الأرباح',
    description:
      'Runs a daily AI scan of margins (06:30 Cairo time); flags unusual margin drops and cost-volume spikes vs a 28-day rolling baseline.',
    descriptionAr:
      'فحص يومي بالذكاء الاصطناعي للهوامش (06:30 بتوقيت القاهرة)؛ ينبّه عند هبوط الهامش أو ارتفاع حجم التكلفة بشكل غير مألوف مقارنةً بمتوسط 28 يومًا.',
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
  payment_abandonment: {
    key: 'payment_abandonment',
    name: 'Payment-Gateway Abandonment Capture',
    nameAr: 'التقاط تخلي عملاء البوابة',
    description:
      'Identify shoppers who reached the payment gateway but did not complete payment. ' +
      'Records are stamped by an automated sweep and surfaced in the retargeting dashboard ' +
      'with customer contact, cart value, and gateway used.',
    descriptionAr:
      'تحديد المتسوّقين الذين وصلوا إلى بوابة الدفع لكنهم لم يُكملوا الدفع. ' +
      'تُسجَّل البيانات بشكل تلقائي وتظهر في لوحة إعادة الاستهداف مع بيانات التواصل وقيمة العربة والبوابة المستخدمة.',
    category: 'marketing',
    tier: 'addon',
  },
  agent_checkout_open_writes: {
    key: 'agent_checkout_open_writes',
    name: 'AI Agent Checkout — open writes (no credential)',
    nameAr: 'الشراء عبر وكلاء الذكاء الاصطناعي — بدون بيانات اعتماد',
    description:
      'Escape hatch. By default the MCP write tools (add_to_cart, place_order) require ' +
      "the store's agent credential; read tools never do. " +
      'Turning this on lets any unauthenticated agent write to this store again — enable it ' +
      'only to unblock a live integration while a credential is issued.',
    descriptionAr:
      'مخرج طوارئ. افتراضياً تتطلب أدوات الكتابة في MCP (إضافة إلى السلة، إنشاء الطلب) ' +
      'بيانات اعتماد وكيل المتجر، أما أدوات القراءة فلا تتطلب ذلك. ' +
      'تفعيل هذا الخيار يسمح لأي وكيل غير موثّق بالكتابة في هذا المتجر مجدداً — فعّله فقط ' +
      'لإصلاح تكامل قائم ريثما تُصدر بيانات الاعتماد.',
    category: 'marketing',
    tier: 'addon',
  },
  merchant_mcp: {
    key: 'merchant_mcp',
    name: 'Merchant MCP (store control for agents)',
    nameAr: 'MCP للتاجر — إدارة المتجر عبر الوكلاء',
    description:
      'Exposes a separate, credential-gated MCP server so the merchant can run their own ' +
      'store from Claude Code or any MCP client instead of the admin dashboard — read ' +
      'analytics, inspect and edit the catalogue, and manage orders. Distinct from AI Agent ' +
      'Checkout, which is the anonymous buyer-facing surface: this one never answers without ' +
      'a merchant key, and its tool list is invisible to anyone who does not hold one.',
    descriptionAr:
      'يوفّر خادم MCP منفصلاً ومحمياً ببيانات اعتماد ليتمكّن التاجر من إدارة متجره من Claude Code ' +
      'أو أي عميل MCP بدلاً من لوحة التحكم — قراءة التحليلات وتصفّح المنتجات وتعديلها وإدارة الطلبات. ' +
      'يختلف عن الشراء عبر الوكلاء الموجّه للمشترين: هذا لا يستجيب أبداً بدون مفتاح التاجر.',
    category: 'marketing',
    tier: 'addon',
  },
  merchant_mcp_write: {
    key: 'merchant_mcp_write',
    name: 'Merchant MCP — write tools',
    nameAr: 'MCP للتاجر — أدوات الكتابة',
    description:
      'Lets the Merchant MCP surface (above) mutate the store — update order status, cancel ' +
      'orders, and more — instead of read-only. Requires Merchant MCP to be on; destructive ' +
      'actions (cancel, delete, refund, bulk) still need a confirm round-trip. On by plan ' +
      'for Growth and Business; the merchant can switch it off per store.',
    descriptionAr:
      'تسمح لـ MCP التاجر (أعلاه) بتعديل المتجر — تحديث حالة الطلب، إلغاء الطلبات، وأكثر — ' +
      'بدلاً من القراءة فقط. يتطلب تفعيل MCP التاجر أولاً؛ والإجراءات الحاسمة (الإلغاء، الحذف، ' +
      'العمليات الجماعية) تحتاج تأكيداً على دفعتين. مفعّلة حسب الباقة (النمو والأعمال)، ويقدر التاجر يقفلها لكل متجر.',
    category: 'marketing',
    tier: 'addon',
  },
  'b2b.wholesale': {
    key: 'b2b.wholesale',
    name: 'Wholesale pricing',
    nameAr: 'أسعار الجملة',
    description:
      'Quantity price breaks, customer-group prices, minimum order quantities, wholesale-only ' +
      'products and a wholesale account application you approve. Included in Business; our team can ' +
      'enable it for a single store otherwise.',
    descriptionAr:
      'خصومات الكميات وأسعار مجموعات العملاء والحد الأدنى للطلب ومنتجات الجملة فقط ' +
      'وطلبات حسابات الجملة التي توافق عليها. مضمّن في باقة الأعمال، ويقدر فريقنا يفعّله لمتجر بعينه.',
    category: 'commerce',
    tier: 'addon',
    // Hidden from the merchant feature list until the merchant + storefront UI ships (Tasks 6-7); a super-admin can
    // still switch it per store in the FeatureMatrix. Task 8 removes both flags.
    hidden: true,
    superAdminToggleable: true,
  },
  remove_branding: {
    key: 'remove_branding',
    name: 'Remove "Powered by Ebda Store"',
    nameAr: 'إزالة «مدعوم من ابدأ ستور»',
    description:
      'Hides the "Powered by Ebda Store" attribution in the storefront footer. Included in Growth ' +
      'and Business; our team can enable it for a single store otherwise.',
    descriptionAr:
      'يخفي عبارة «مدعوم من ابدأ ستور» من تذييل المتجر. مضمّن في باقتي النمو والأعمال، ' +
      'ويقدر فريقنا يفعّله لمتجر بعينه.',
    category: 'storefront',
    tier: 'addon',
  },
  product_3d: {
    key: 'product_3d',
    name: '3D product models + AR',
    nameAr: 'موديلات ثلاثية الأبعاد + الواقع المعزز',
    description:
      'Upload a 3D model (.glb) of a product: shoppers rotate and zoom it on the product page, ' +
      'see it change with the chosen colour or metal, and place it in their room on iPhone and ' +
      'Android. Included in every plan.',
    descriptionAr:
      'ارفع موديل ثلاثي الأبعاد (‎.glb‎) للمنتج: العميل يلفّه ويقرّبه في صفحة المنتج، ويشوفه ' +
      'بيتغيّر مع اللون أو المعدن اللي اختاره، ويحطه في أوضته على آيفون وأندرويد. متاح في كل الباقات.',
    category: 'storefront',
    tier: 'core',
  },
  bundles: {
    key: 'bundles',
    name: 'Product Bundles',
    nameAr: 'مجموعات المنتجات',
    description:
      'Sell a fixed kit of products as one item at one price. Stock is drawn from the ' +
      'component products, so nothing is double-counted.',
    descriptionAr:
      'بيع مجموعة ثابتة من المنتجات كعنصر واحد بسعر واحد. يُخصم المخزون من المنتجات ' +
      'المكوّنة، فلا يُحتسب أي صنف مرتين.',
    category: 'commerce',
    tier: 'addon',
  },
  eta_ereceipt: {
    key: 'eta_ereceipt',
    name: 'ETA e-receipts (Egypt)',
    nameAr: 'الإيصال الإلكتروني (مصلحة الضرائب)',
    description:
      'For VAT-registered Egyptian merchants: send every paid order to the Egyptian Tax Authority ' +
      'as an e-receipt using your own ETA credentials.',
    descriptionAr:
      'للتجار المسجّلين في ضريبة القيمة المضافة: إرسال كل طلب مدفوع لمصلحة الضرائب المصرية ' +
      'كإيصال إلكتروني باستخدام بيانات الدخول الخاصة بك.',
    category: 'operations',
    tier: 'addon',
    hidden: true,
    superAdminToggleable: true,
  },
  customer_intelligence: {
    key: 'customer_intelligence',
    name: 'Smart hints (Customer Intelligence)',
    nameAr: 'تلميحات ذكية من نتائج طلباتك',
    description:
      'Advice from your own delivery and return history: a COD risk note on an order, which courier has delivered best to an area, and when a COD amount starts to return more. Hints only ever advise: they never hold, delay or cancel an order, and each one shows how many orders it rests on.',
    descriptionAr:
      'نصايح من تاريخ توصيل وارتجاع طلباتك: ملاحظة على خطر الدفع عند الاستلام في الطلب، وأنهي شركة شحن وصّلت أحسن لمنطقة معينة، ومتى يبدأ مبلغ الدفع عند الاستلام يرجع أكتر. التلميحات بتنصح بس: عمرها ما بتوقف أو تأجّل أو تلغي طلب، وكل واحد بيوضّح عدد الطلبات اللي اعتمد عليها.',
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
