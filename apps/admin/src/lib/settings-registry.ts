/**
 * THE source of truth for admin search (search program P2, E23): every admin page and every
 * individual setting a merchant can look for, in Arabic and English.
 *
 *  - `labelKey` is a dot path into the admin messages (ar.json + en.json). Both languages are
 *    read from there, so a label is written once and a rename follows. The committed
 *    `settings-search-index.generated.json` is that resolution (`npm run gen:settings-search -w
 *    apps/admin`); the client reads only the generated file, never the 1 MB message files.
 *  - A `page` entry is a route under `/stores/[id]`. A `setting` entry is ONE control on a route
 *    and is deep-linked as `?setting=<id>`: the page marks the control with
 *    `data-setting-id="<id>"`, and `useSettingHighlight` (AdminLayout) scrolls to it, opens its
 *    collapsed ancestors and highlights it. `query` selects the tab that holds the control.
 *  - `access` mirrors the sidebar: 'staff' = every team member; 'owner' = store owner / super
 *    admin (the Finance and Settings hubs are hidden from staff); 'super_admin' = platform only.
 *    `feature` hides the entry while the store's feature map does not enable it.
 *
 * Coverage is enforced by `tests/unit/settings-registry.test.ts`: every static admin page route is
 * here (or on REDIRECT_ROUTES), every anchor in the source is registered and every registered
 * anchor exists, every label resolves in both languages, the generated index is current, access
 * and feature agree with the sidebar hubs and the pages' own `useRequireFeature` gates, and the
 * labelled controls of the settings pages cannot grow past SETTINGS_LABEL_BASELINE without a
 * registry entry being added alongside.
 */

export type SettingAccess = 'staff' | 'owner' | 'super_admin';

interface EntryBase {
  /** Stable id. Page: `page:/route`. Setting: `<area>.<name>`; it is also the `?setting=` value. */
  id: string;
  /** Path under `/stores/[id]`, e.g. '/delivery'. '/' is the store dashboard. */
  route: string;
  /** Dot path into the admin messages; must exist in BOTH ar.json and en.json. */
  labelKey: string;
  access: SettingAccess;
  /** Feature-map key that must be ON for the entry to be shown. */
  feature?: string;
  /** Everyday words, per language, that should find this entry (the label is searched already). */
  syn?: { en?: string; ar?: string };
}

export interface PageEntry extends EntryBase {
  kind: 'page';
}

export interface SettingEntry extends EntryBase {
  kind: 'setting';
  /** Query that selects the tab holding the control, e.g. 'tab=theme'. */
  query?: string;
}

export type RegistryEntry = PageEntry | SettingEntry;

const HUB = 'components.adminLayout.hubTabs';

const page = (
  route: string,
  labelKey: string,
  access: SettingAccess,
  extra: { feature?: string; syn?: { en?: string; ar?: string } } = {}
): PageEntry => ({
  kind: 'page',
  id: `page:${route}`,
  route,
  labelKey,
  access,
  ...extra,
});

const setting = (
  id: string,
  route: string,
  labelKey: string,
  access: SettingAccess,
  syn: { en?: string; ar?: string },
  extra: { query?: string; feature?: string } = {}
): SettingEntry => ({ kind: 'setting', id, route, labelKey, access, syn, ...extra });

/**
 * Static routes that only redirect (the page file calls `redirect()` or renders a thin redirect
 * component). Not searchable themselves; the page they land on is. The test checks each one really
 * is a redirect, so a stub that grows content must be registered instead.
 */
export const REDIRECT_ROUTES: Record<string, string> = {
  '/hero': '/builder',
  '/insights': '/insights/dashboard',
  '/inventory': '/stock/inventory',
  '/navigation': '/builder',
  '/page-builder': '/builder',
  '/pages': '/builder',
  '/qr': '/codes',
};

export const PAGES: PageEntry[] = [
  page('/', 'nav.dashboard', 'staff', {
    syn: { en: 'home overview start', ar: 'الرئيسية نظرة عامة ابدأ' },
  }),
  // ── Catalog ────────────────────────────────────────────────────────────────
  page('/products', `${HUB}.products`, 'staff', {
    syn: { en: 'items goods catalog sku', ar: 'سلع بضاعة كتالوج منتجات' },
  }),
  page('/products/new', 'products.new.title', 'staff', {
    syn: { en: 'create product new item', ar: 'اضافة منتج جديد' },
  }),
  page('/products/best-sellers/order', 'products.bestSellersOrder.title', 'staff', {
    syn: { en: 'sort order featured homepage', ar: 'ترتيب الاكثر مبيعا' },
  }),
  page('/products/new-arrivals/order', 'products.newArrivalsOrder.title', 'staff', {
    syn: { en: 'sort order latest homepage', ar: 'ترتيب وصل حديثا' },
  }),
  page('/categories', 'categories.page.title', 'staff', {
    syn: { en: 'collections groups', ar: 'اقسام تصنيفات مجموعات' },
  }),
  page('/tags', 'tags.page.title', 'staff', {
    syn: { en: 'skin type concern chips labels translate', ar: 'وسوم نوع البشرة المشكلة ترجمة' },
  }),
  page('/bulk', 'bulk.page.title', 'staff', {
    feature: 'bulk_operations',
    syn: {
      en: 'import export csv excel upload photo pdf catalogue catalog price list menu image',
      ar: 'استيراد تصدير اكسل رفع جماعي صور PDF كتالوج قائمة أسعار منيو',
    },
  }),
  page('/builder', `${HUB}.editor`, 'staff', {
    syn: {
      en: 'visual editor drag drop design homepage layout sections banner hero menu navigation',
      ar: 'محرر مرئي تصميم سحب الصفحة الرئيسية اقسام بانر قائمة تنقل',
    },
  }),
  page('/content', `${HUB}.content`, 'staff', {
    syn: { en: 'static pages about contact policy', ar: 'صفحات من نحن سياسة اتصل' },
  }),
  // T4: the FAQ and how-to guides moved here from the SEO page (UX:SEO-3).
  page('/content/faqs', 'seo.page.faqsTitle', 'owner', {
    syn: {
      en: 'faq questions answers how to guides',
      ar: 'اسئلة واجوبة الاسئلة الشائعة ادلة خطوات',
    },
  }),
  page('/blog', `${HUB}.blog`, 'staff', {
    syn: { en: 'posts articles news', ar: 'مقالات اخبار مدونة' },
  }),
  page('/floating-widget', `${HUB}.floatingWidget`, 'staff', {
    syn: { en: 'chat button whatsapp call float', ar: 'زر عائم واتساب اتصال' },
  }),
  page('/size-charts', 'sizeCharts.page.title', 'staff', {
    syn: {
      en: 'size guide measurements fit abaya shoes clothes',
      ar: 'جدول المقاسات قياسات مقاس عباية حذاء ملابس',
    },
  }),
  page('/gold-rates', 'goldRates.page.title', 'staff', {
    syn: {
      en: 'gold price rate karat jewellery jewelry making charge',
      ar: 'سعر الدهب عيار ذهب مصنعية مجوهرات',
    },
  }),
  // ── Sales ──────────────────────────────────────────────────────────────────
  page('/orders', `${HUB}.orders`, 'staff', {
    syn: { en: 'sales purchases', ar: 'مبيعات مشتريات' },
  }),
  page('/orders/packing-slips', 'packingSlip.print', 'staff', {
    syn: {
      en: 'packing slip print label shipping barcode scan',
      ar: 'بوليصة تغليف طباعة ملصق شحن باركود',
    },
  }),
  page('/orders/new', 'orders.new.title', 'staff', {
    syn: { en: 'create order phone order manual order', ar: 'طلب جديد طلب هاتفي يدوي' },
  }),
  page('/invoices', `${HUB}.invoices`, 'staff', {
    syn: { en: 'tax invoice receipt credit note', ar: 'فاتورة ضريبية ايصال اشعار دائن' },
  }),
  page('/customers', `${HUB}.customers`, 'staff', {
    syn: { en: 'clients buyers crm contacts', ar: 'زبائن عملاء جهات اتصال' },
  }),
  page('/customer-groups', `${HUB}.customerGroups`, 'staff', {
    syn: { en: 'segments wholesale vip groups', ar: 'مجموعات شرائح جملة' },
  }),
  page('/reviews', `${HUB}.reviews`, 'staff', {
    syn: { en: 'ratings feedback stars', ar: 'تقييمات اراء نجوم' },
  }),
  page('/returns', `${HUB}.returns`, 'staff', {
    feature: 'returns',
    syn: { en: 'refunds exchanges rma', ar: 'استرجاع استبدال ارجاع' },
  }),
  page('/coupons', `${HUB}.coupons`, 'staff', {
    feature: 'coupons',
    syn: { en: 'discount code voucher promo', ar: 'كود خصم قسيمة' },
  }),
  page('/promotions', `${HUB}.promotions`, 'staff', {
    syn: { en: 'sale deals automatic discount offers', ar: 'عروض تخفيضات خصم تلقائي' },
  }),
  page('/loyalty', `${HUB}.loyalty`, 'staff', {
    feature: 'loyalty',
    syn: { en: 'points rewards tiers', ar: 'نقاط مكافات ولاء' },
  }),
  page('/loyalty/transactions', 'loyalty.transactions.title', 'staff', {
    feature: 'loyalty',
    syn: { en: 'points history ledger', ar: 'سجل النقاط' },
  }),
  page('/bundles', `${HUB}.bundles`, 'staff', {
    feature: 'bundles',
    syn: { en: 'kits combos sets', ar: 'باقات عروض مجمعة' },
  }),
  page('/wallet', `${HUB}.wallet`, 'staff', {
    feature: 'customer_wallet',
    syn: { en: 'store credit balance', ar: 'رصيد محفظة' },
  }),
  page('/customer-intelligence', `${HUB}.customerIntelligence`, 'staff', {
    syn: {
      en: 'cod risk courier suggestion returns hints intelligence sharing',
      ar: 'تلميحات خطر الدفع عند الاستلام شركة الشحن المرتجعات',
    },
  }),
  page('/payment-abandonments', `${HUB}.paymentAbandonments`, 'staff', {
    feature: 'payment_abandonment',
    syn: { en: 'failed payment abandoned checkout', ar: 'دفع فاشل تخلي' },
  }),
  page('/lifecycle-emails', `${HUB}.lifecycleEmails`, 'staff', {
    syn: {
      en: 'setup emails onboarding trial reminder referral unsubscribe',
      ar: 'رسائل البداية التجربة تذكير إلغاء اشتراك',
    },
  }),
  // ── Stock ──────────────────────────────────────────────────────────────────
  page('/stock/dashboard', 'stock.dashboard.title', 'staff', {
    syn: { en: 'inventory overview stock levels', ar: 'نظرة عامة على المخزون' },
  }),
  page('/stock/inventory', 'stock.inventory.title', 'staff', {
    syn: { en: 'stock quantity count', ar: 'مخزون كمية جرد' },
  }),
  page('/stock/warehouses', 'stock.warehouses.title', 'staff', {
    syn: { en: 'locations depot branches', ar: 'مخازن مواقع فروع' },
  }),
  page('/stock/adjustments', 'stock.adjustments.title', 'staff', {
    syn: { en: 'stock correction damaged lost', ar: 'تسوية تالف مفقود' },
  }),
  page('/stock/adjustments/new', 'stock.adjustments.new.title', 'staff', {
    syn: { en: 'add stock remove stock', ar: 'اضافة مخزون خصم مخزون' },
  }),
  page('/stock/suppliers', 'stock.suppliers.title', 'staff', {
    syn: { en: 'vendors purchasing', ar: 'موردين بائعين' },
  }),
  page('/stock/suppliers/new', 'stock.suppliers.new.title', 'staff', {
    syn: { en: 'add supplier vendor', ar: 'اضافة مورد' },
  }),
  page('/stock/purchase-orders', 'stock.purchaseOrders.title', 'staff', {
    syn: { en: 'po buying restock', ar: 'اوامر شراء توريد' },
  }),
  page('/stock/purchase-orders/new', 'stock.purchaseOrders.new.title', 'staff', {
    syn: { en: 'create purchase order', ar: 'امر شراء جديد' },
  }),
  page('/stock/backorders', 'stock.backorders.title', 'staff', {
    syn: { en: 'preorder out of stock waiting', ar: 'طلب مسبق نفد المخزون انتظار' },
  }),
  page('/stock/reorder', 'stock.reorder.title', 'staff', {
    syn: { en: 'reorder point low stock', ar: 'نقطة اعادة الطلب مخزون منخفض' },
  }),
  page('/stock/reorder/rules', 'stock.reorderRules.title', 'owner', {
    syn: {
      en: 'reorder rules minimum stock threshold restock',
      ar: 'قواعد اعادة الطلب حد ادنى مخزون',
    },
  }),
  page('/stock/deadstock', 'stock.deadstock.title', 'staff', {
    syn: { en: 'slow moving unsold old stock', ar: 'راكد بضاعة قديمة' },
  }),
  page('/stock/scan', `${HUB}.scan`, 'staff', {
    syn: { en: 'barcode scanner camera', ar: 'باركود ماسح كاميرا' },
  }),
  // ── Finance (owner) ────────────────────────────────────────────────────────
  page('/finance/dashboard', 'finance.dashboard.title', 'owner', {
    syn: { en: 'accounting profit overview', ar: 'محاسبة ارباح نظرة عامة' },
  }),
  page('/finance/accounts', 'finance.accounts.title', 'owner', {
    syn: { en: 'ledger coa accounts', ar: 'دليل الحسابات دفتر' },
  }),
  page('/finance/journal', 'finance.journal.title', 'owner', {
    syn: { en: 'bookkeeping entries', ar: 'قيود يومية محاسبة' },
  }),
  page('/finance/journal/new', 'finance.newEntry.title', 'owner', {
    syn: { en: 'manual entry journal', ar: 'قيد يدوي' },
  }),
  page('/finance/expenses', 'finance.expenses.title', 'owner', {
    syn: { en: 'costs spending bills receipts', ar: 'مصروفات نفقات فواتير' },
  }),
  page('/finance/expenses/new', 'finance.expenses.new.title', 'owner', {
    syn: { en: 'add expense receipt', ar: 'اضافة مصروف ايصال' },
  }),
  page('/finance/reports', 'finance.reports.title', 'owner', {
    syn: {
      en: 'pnl profit and loss balance sheet statements',
      ar: 'تقارير قوائم مالية ارباح وخسائر ميزانية',
    },
  }),
  page('/finance/bank-reconciliation', 'finance.bankRec.title', 'owner', {
    syn: { en: 'bank statement match', ar: 'كشف بنك مطابقة' },
  }),
  page('/finance/bank-reconciliation/import', 'finance.bankRec.import.title', 'owner', {
    syn: { en: 'upload bank statement csv', ar: 'رفع كشف بنك' },
  }),
  page('/finance/fx-rates', 'finance.fxRates.title', 'owner', {
    syn: { en: 'exchange rate currency dollar', ar: 'سعر الصرف عملة دولار' },
  }),
  page('/finance/anomalies', 'finance.anomalies.title', 'owner', {
    feature: 'accounting.profit_anomaly',
    syn: { en: 'profit anomaly unusual loss', ar: 'شذوذ ربحية خسارة' },
  }),
  // ── Analytics ──────────────────────────────────────────────────────────────
  page('/analytics', 'analytics.page.title', 'staff', {
    syn: { en: 'reports stats traffic sales revenue', ar: 'تقارير احصائيات زيارات ايرادات' },
  }),
  page('/insights/dashboard', 'insights.dashboard.title', 'staff', {
    syn: { en: 'insights ai narrative', ar: 'احصاءات رؤى' },
  }),
  page('/insights/cohorts', 'insights.cohorts.title', 'staff', {
    syn: { en: 'retention repeat customers', ar: 'احتفاظ عملاء متكررين' },
  }),
  page('/insights/funnel', `${HUB}.insightsFunnel`, 'staff', {
    syn: { en: 'conversion checkout drop off', ar: 'تحويل قمع مبيعات' },
  }),
  page('/insights/products', 'insights.products.title', 'staff', {
    syn: { en: 'best sellers velocity', ar: 'الاكثر مبيعا سرعة بيع' },
  }),
  page('/insights/searches', 'insights.searches.title', 'staff', {
    syn: {
      en: 'search terms zero results what shoppers search',
      ar: 'كلمات بحث بدون نتائج بحث العملاء',
    },
  }),
  page('/insights/segments', 'insights.segments.title', 'staff', {
    syn: { en: 'rfm vip loyal at risk', ar: 'شرائح عملاء مميزين' },
  }),
  // ── Marketing ──────────────────────────────────────────────────────────────
  page('/ai-tools', 'aiTools.title', 'staff', {
    feature: 'bulk_operations',
    syn: { en: 'ai gemini translate seo autofill bulk', ar: 'ذكاء اصطناعي ترجمة تعبئة تلقائية' },
  }),
  page('/ai-usage', `${HUB}.aiUsage`, 'staff', {
    syn: { en: 'ai credits quota spending', ar: 'استهلاك الذكاء الاصطناعي رصيد' },
  }),
  page('/answer-engine', `${HUB}.answerEngine`, 'staff', {
    feature: 'answer_engine_insights',
    syn: { en: 'chatgpt perplexity ai search visibility aeo', ar: 'محركات الاجابة ظهور' },
  }),
  page('/notifications', `${HUB}.notifications`, 'staff', {
    syn: { en: 'push alerts broadcast', ar: 'اشعارات تنبيهات' },
  }),
  page('/newsletter', `${HUB}.newsletter`, 'staff', {
    syn: { en: 'email subscribers list', ar: 'نشرة بريدية مشتركين' },
  }),
  page('/campaigns', `${HUB}.campaigns`, 'staff', {
    feature: 'email_campaigns',
    syn: { en: 'email marketing send blast', ar: 'حملات بريد تسويق ارسال' },
  }),
  page('/webhooks', 'webhooks.page.title', 'owner', {
    syn: {
      en: 'webhooks api events signed endpoint integration',
      ar: 'ويب هوك ربط احداث تكامل',
    },
  }),
  page('/wholesale-applications', 'wholesale.applications.title', 'staff', {
    feature: 'b2b.wholesale',
    syn: {
      en: 'wholesale b2b trade accounts applications approve reject buyers',
      ar: 'جملة تجار طلبات حسابات موافقة رفض',
    },
  }),
  page('/abandoned-carts', `${HUB}.abandonedCarts`, 'staff', {
    feature: 'abandoned_cart',
    syn: { en: 'cart recovery left behind', ar: 'سلة متروكة استرداد' },
  }),
  page('/marketing-pixels', `${HUB}.marketingPixels`, 'staff', {
    feature: 'marketing_pixels',
    syn: {
      en: 'facebook tiktok snapchat google ads tracking pixel',
      ar: 'فيسبوك تيك توك سناب بكسل تتبع اعلانات',
    },
  }),
  page('/product-feeds', `${HUB}.productFeeds`, 'staff', {
    feature: 'product_feeds',
    syn: {
      en: 'google merchant center shopping meta commerce manager facebook instagram tiktok catalog catalogue feed xml csv',
      ar: 'جوجل ميرتشنت شوبينج ميتا فيسبوك انستجرام تيك توك كتالوج خلاصة منتجات',
    },
  }),
  page('/affiliates', `${HUB}.affiliates`, 'staff', {
    feature: 'affiliate',
    syn: { en: 'referral partners commission', ar: 'تسويق بالعمولة شركاء احالة' },
  }),
  // ── Settings hub (owner) ───────────────────────────────────────────────────
  page('/settings', 'settings.page.title', 'owner', {
    syn: { en: 'preferences configuration store settings', ar: 'اعدادات تفضيلات تهيئة' },
  }),
  page('/branding', 'branding.page.title', 'owner', {
    syn: {
      en: 'logo brand identity name colors favicon social links contact',
      ar: 'شعار هوية اسم المتجر الوان روابط تواصل',
    },
  }),
  page('/announcement', 'announcement.page.title', 'owner', {
    syn: { en: 'banner top bar message strip', ar: 'شريط اعلان رسالة علوي' },
  }),
  page('/seo', 'seo.page.title', 'owner', {
    feature: 'seo',
    syn: {
      en: 'google search engine meta title description keywords',
      ar: 'سيو جوجل محركات البحث عنوان وصف',
    },
  }),
  page('/seo/redirects', 'seo.page.redirectsTitle', 'owner', {
    feature: 'seo',
    syn: { en: 'redirect old url 301 slug', ar: 'تحويل رابط قديم' },
  }),
  page('/domain', 'domain.page.title', 'owner', {
    syn: { en: 'custom domain dns website address email sender', ar: 'نطاق دومين رابط الموقع' },
  }),
  page('/payment-settings', 'paymentSettings.page.title', 'owner', {
    syn: {
      en: 'payment gateway paymob kashier fawry instapay cod cash on delivery card wallet',
      ar: 'دفع بوابة باي موب كاشير فوري انستاباي الدفع عند الاستلام بطاقة محفظة',
    },
  }),
  page('/shipping', 'settings.cards.shipping.title', 'owner', {
    syn: {
      en: 'delivery rates zones areas governorate fees free shipping return policy',
      ar: 'شحن توصيل مناطق محافظات رسوم شحن مجاني سياسة الارجاع',
    },
  }),
  page('/shipping-carriers', 'shipping.carriers.page.title', 'owner', {
    feature: 'shipping_carriers',
    syn: { en: 'courier bosta aramex tracking', ar: 'شركات الشحن بوسطة ارامكس تتبع' },
  }),
  page('/cod-reconciliation', 'codReconciliation.title', 'owner', {
    feature: 'shipping_carriers',
    syn: {
      en: 'cash on delivery collected courier settlement',
      ar: 'تحصيل الدفع عند الاستلام تسوية',
    },
  }),
  page('/delivery', 'checkoutDelivery.page.title', 'owner', {
    syn: {
      en: 'delivery time window note minimum order days off',
      ar: 'توصيل موعد ملاحظة حد ادنى للطلب ايام',
    },
  }),
  page('/tax', 'tax.page.title', 'owner', {
    syn: { en: 'vat tax rate invoice', ar: 'ضريبة القيمة المضافة معدل' },
  }),
  page('/pwa', 'pwa.page.title', 'owner', {
    feature: 'pwa',
    syn: { en: 'app install home screen mobile icon', ar: 'تطبيق تثبيت شاشة رئيسية جوال ايقونة' },
  }),
  page('/codes', 'codes.page.title', 'owner', {
    syn: {
      en: 'qr code barcode label sticker print scan poster flyer receipt thermal a4 ean',
      ar: 'كود كيو ار باركود ملصق طباعة مسح بوستر فلاير فاتورة حراري',
    },
  }),
  page('/language', 'language.page.title', 'owner', {
    syn: {
      en: 'arabic english default language rtl translation',
      ar: 'عربي انجليزي لغة افتراضية ترجمة',
    },
  }),
  page('/template', 'template.page.title', 'owner', {
    syn: { en: 'theme design skin look storefront', ar: 'قالب تصميم مظهر شكل المتجر' },
  }),
  page('/agent-key', 'agentKey.page.title', 'owner', {
    feature: 'agent_checkout',
    syn: { en: 'ai agent mcp key chatgpt claude shopping', ar: 'مفتاح وكيل ذكاء اصطناعي شراء' },
  }),
  page('/merchant-keys', 'merchantKeys.page.title', 'owner', {
    feature: 'merchant_mcp',
    syn: {
      en: 'api key mcp token manage store with ai',
      ar: 'مفتاح api رمز ادارة المتجر بالذكاء الاصطناعي',
    },
  }),
  page('/billing', 'billing.title', 'owner', {
    syn: {
      en: 'plan subscription upgrade invoice usage limits',
      ar: 'باقة اشتراك ترقية فاتورة استخدام حدود',
    },
  }),
  page('/staff', 'staff.page.title', 'owner', {
    feature: 'staff_accounts',
    syn: { en: 'team members roles permissions invite employee', ar: 'موظفين فريق صلاحيات دعوة' },
  }),
  page('/features', 'features.page.manageTitle', 'super_admin', {
    syn: { en: 'feature flags addons enable', ar: 'مزايا اضافات تفعيل' },
  }),
];

export const SETTINGS: SettingEntry[] = [
  // ── AI ────────────────────────────────────────────────────────────────────
  setting(
    'ai.switch',
    '/ai-usage',
    'aiSwitch.title',
    'owner',
    {
      en: 'ai on off disable enable turn off assistant gemini switch',
      ar: 'ذكاء اصطناعي تشغيل ايقاف قفل تفعيل مساعد',
    },
    {}
  ),
  // ── Branding (tabs: branding · theme · contact · locations) ───────────────
  setting(
    'branding.logo',
    '/branding',
    'branding.identity.logo',
    'owner',
    {
      en: 'change logo store logo upload logo brand image header',
      ar: 'تغيير الشعار شعار المتجر رفع الشعار لوجو صورة',
    },
    { query: 'tab=branding' }
  ),
  setting(
    'branding.logo-ar',
    '/branding',
    'branding.identity.logoAr',
    'owner',
    {
      en: 'arabic logo rtl logo',
      ar: 'الشعار العربي لوجو عربي',
    },
    { query: 'tab=branding' }
  ),
  setting(
    'branding.store-name',
    '/branding',
    'branding.identity.storeName',
    'owner',
    {
      en: 'store name shop name business name rename',
      ar: 'اسم المتجر اسم المحل تغيير الاسم',
    },
    { query: 'tab=branding' }
  ),
  setting(
    'branding.logo-size',
    '/branding',
    'branding.theme.logoSize.title',
    'owner',
    {
      en: 'logo size bigger smaller header logo',
      ar: 'حجم الشعار تكبير تصغير',
    },
    { query: 'tab=theme' }
  ),
  setting(
    'branding.footer-logo',
    '/branding',
    'branding.theme.footerLogo.title',
    'owner',
    {
      en: 'footer logo white logo invert',
      ar: 'شعار التذييل الفوتر شعار ابيض',
    },
    { query: 'tab=theme' }
  ),
  setting('branding.blog', '/blog', 'branding.theme.blog.title', 'owner', {
    en: 'blog show blog turn on blog',
    ar: 'تفعيل المدونة اظهار المدونة',
  }),
  setting('branding.web-push', '/notifications', 'branding.theme.webPush.title', 'owner', {
    en: 'web push notifications subscribe prompt',
    ar: 'اشعارات الويب اشتراك اشعارات',
  }),
  setting(
    'branding.whatsapp-buttons',
    '/branding',
    'branding.contact.waMeTitle',
    'owner',
    {
      en: 'whatsapp button chat link wa.me contact number',
      ar: 'واتساب زر واتساب رقم واتساب تواصل',
    },
    { query: 'tab=contact' }
  ),
  setting(
    'branding.locations',
    '/branding',
    'branding.locations.enableTitle',
    'owner',
    {
      en: 'branches locations stores map addresses',
      ar: 'الفروع فروع عناوين خريطة',
    },
    { query: 'tab=locations' }
  ),
  // ── Delivery (checkout) ────────────────────────────────────────────────────
  setting('delivery.note', '/delivery', 'checkoutDelivery.page.noteSectionTitle', 'owner', {
    en: 'delivery note message shown at checkout',
    ar: 'ملاحظة التوصيل رسالة عند الدفع',
  }),
  setting('delivery.windows', '/delivery', 'checkoutDelivery.page.windowsSectionTitle', 'owner', {
    en: 'delivery time slots morning evening window picker',
    ar: 'مواعيد التوصيل فترات صباحا مساء',
  }),
  setting('delivery.days-ahead', '/delivery', 'checkoutDelivery.page.daysAheadTitle', 'owner', {
    en: 'delivery date picker days ahead choose a day schedule delivery calendar',
    ar: 'يوم التوصيل اختيار اليوم جدولة التوصيل تقويم',
  }),
  setting(
    'delivery.min-order',
    '/delivery',
    'checkoutDelivery.page.minOrderSectionTitle',
    'owner',
    {
      en: 'minimum order amount minimum cart value',
      ar: 'الحد الادنى للطلب اقل قيمة طلب',
    }
  ),
  setting('delivery.days', '/delivery', 'checkoutDelivery.page.deliveryDaysTitle', 'owner', {
    en: 'delivery days how many days delivery time estimate',
    ar: 'مدة التوصيل عدد ايام التوصيل تقدير',
  }),
  setting('delivery.off-days', '/delivery', 'checkoutDelivery.page.deliveryOffDaysTitle', 'owner', {
    en: 'delivery days no delivery days holiday weekend friday closed days off',
    ar: 'ايام بدون توصيل اجازة الجمعة عطلة ايام الاجازة',
  }),
  setting(
    'delivery.invoice-email',
    '/delivery',
    'checkoutDelivery.page.invoiceEmailSectionTitle',
    'owner',
    {
      en: 'invoice email recipient order invoice copy',
      ar: 'بريد الفاتورة مستلم الفاتورة',
    }
  ),
  // ── Shipping ───────────────────────────────────────────────────────────────
  setting('shipping.area-rates', '/shipping', 'shipping.areaRates.sectionTitle', 'owner', {
    en: 'shipping fees delivery price governorate cities zones rates free shipping threshold free delivery over amount',
    ar: 'رسوم الشحن سعر التوصيل المحافظات المدن مناطق شحن مجاني حد الشحن المجاني توصيل مجاني',
  }),
  setting('shipping.return-policy', '/shipping', 'shipping.returnPolicy.title', 'owner', {
    en: 'return window days refund who pays return shipping',
    ar: 'سياسة الارجاع مدة الارجاع شحن الارجاع',
  }),
  // ── Payment ────────────────────────────────────────────────────────────────
  setting('payment.cod-fee', '/payment-settings', 'paymentSettings.cod.fixedFeeLabel', 'owner', {
    en: 'cash on delivery fee cod surcharge extra fee',
    ar: 'رسوم الدفع عند الاستلام رسوم اضافية',
  }),
  setting(
    'payment.instapay-handle',
    '/payment-settings',
    'paymentSettings.instapay.handleLabel',
    'owner',
    {
      en: 'instapay address ipa bank transfer account',
      ar: 'انستاباي عنوان تحويل بنكي حساب',
    }
  ),
  setting(
    'payment.instapay-expiry',
    '/payment-settings',
    'paymentSettings.instapay.expiryLabel',
    'owner',
    {
      en: 'hold order hours payment deadline expire instapay',
      ar: 'مدة الاحتفاظ بالطلب ساعات انتهاء الدفع',
    }
  ),
  setting(
    'payment.instalments',
    '/payment-settings',
    'paymentSettings.instalments.title',
    'owner',
    {
      en: 'instalment installments monthly payment months estimate tagseet product page',
      ar: 'تقسيط قسط شهري شهور تقريبي صفحة المنتج',
    }
  ),
  // ── Tax ────────────────────────────────────────────────────────────────────
  setting('tax.enable', '/tax', 'tax.settings.enable.title', 'owner', {
    en: 'turn on vat charge tax collect tax',
    ar: 'تفعيل الضريبة تحصيل ضريبة القيمة المضافة',
  }),
  setting('tax.included', '/tax', 'tax.settings.included.title', 'owner', {
    en: 'prices include tax tax inclusive vat included',
    ar: 'الاسعار تشمل الضريبة شامل الضريبة',
  }),
  setting('tax.rates', '/tax', 'tax.rates.title', 'owner', {
    en: 'vat rate 14% add tax rate percentage',
    ar: 'معدل الضريبة نسبة 14 اضافة ضريبة',
  }),
  setting('tax.time-zone', '/tax', 'tax.timeZone.title', 'owner', {
    en: 'time zone timezone cairo clock',
    ar: 'المنطقة الزمنية توقيت القاهرة',
  }),
  setting(
    'tax.eta',
    '/tax',
    'eta.title',
    'owner',
    {
      en: 'eta e-receipt electronic receipt egyptian tax authority pos serial client id secret',
      ar: 'الايصال الالكتروني مصلحة الضرائب رقم الجهاز',
    },
    { feature: 'eta_ereceipt' }
  ),
  // ── PWA / language / domain / SEO ──────────────────────────────────────────
  setting(
    'pwa.app-name',
    '/pwa',
    'pwa.branding.appName',
    'owner',
    {
      en: 'app name home screen name install name',
      ar: 'اسم التطبيق اسم الشاشة الرئيسية',
    },
    { feature: 'pwa' }
  ),
  setting(
    'pwa.short-name',
    '/pwa',
    'pwa.branding.shortName',
    'owner',
    {
      en: 'short name icon label',
      ar: 'الاسم المختصر اسم الايقونة',
    },
    { feature: 'pwa' }
  ),
  setting('language.default', '/language', 'language.page.defaultTitle', 'owner', {
    en: 'default language arabic english switch language store language',
    ar: 'اللغة الافتراضية تغيير اللغة عربي انجليزي',
  }),
  setting('domain.email-sender', '/domain', 'domain.page.emailSenderTitle', 'owner', {
    en: 'email sender from address order emails own domain',
    ar: 'مرسل البريد عنوان المرسل ايميلات الطلبات',
  }),
  setting(
    'seo.meta-title',
    '/seo',
    'seo.page.metaTitle',
    'owner',
    {
      en: 'page title google title browser tab title',
      ar: 'عنوان الصفحة عنوان جوجل عنوان الميتا',
    },
    { feature: 'seo' }
  ),
  setting(
    'seo.hide-from-search',
    '/seo',
    'seo.page.hideFromSearchTitle',
    'owner',
    {
      en: 'hide store from google search engines noindex private draft not live launch',
      ar: 'اخفاء المتجر من جوجل محركات البحث مخفي قبل الاطلاق',
    },
    { feature: 'seo' }
  ),
  setting(
    'seo.aeo',
    '/seo',
    'seo.page.aeoTitle',
    'owner',
    {
      en: 'ai search chatgpt answer engine optimization description',
      ar: 'محركات الذكاء الاصطناعي تحسين الاجابة وصف',
    },
    { feature: 'seo' }
  ),
  setting(
    'seo.faqs',
    '/content/faqs',
    'seo.page.faqsTitle',
    'owner',
    {
      en: 'faq questions answers common questions',
      ar: 'الاسئلة الشائعة اسئلة واجوبة',
    },
    { feature: 'seo' }
  ),
  setting(
    'seo.how-tos',
    '/content/faqs',
    'seo.page.howtosTitle',
    'owner',
    {
      en: 'how to guides instructions steps',
      ar: 'ادلة الارشادات تعليمات خطوات',
    },
    { feature: 'seo' }
  ),
  // ── Floating widget ────────────────────────────────────────────────────────
  setting('floating-widget.show', '/floating-widget', 'floatingWidget.showWidgetLabel', 'staff', {
    en: 'show hide floating button chat widget whatsapp button on store',
    ar: 'اظهار اخفاء الزر العائم ودجة واتساب',
  }),
  setting('floating-widget.position', '/floating-widget', 'floatingWidget.positionLabel', 'staff', {
    en: 'widget position left right corner',
    ar: 'موضع الودجة يمين يسار',
  }),
  setting(
    'floating-widget.expand',
    '/floating-widget',
    'floatingWidget.expandDirectionLabel',
    'staff',
    {
      en: 'expand direction up down open',
      ar: 'اتجاه الفتح اعلى اسفل',
    }
  ),
  // ── Notifications ──────────────────────────────────────────────────────────
  setting('notifications.broadcast', '/notifications', 'notifications.broadcast.title', 'staff', {
    en: 'send push notification to customers announcement broadcast',
    ar: 'ارسال اشعار للعملاء اشعار جماعي',
  }),
  setting('notifications.events', '/notifications', 'notifications.events.title', 'staff', {
    en: 'which events send notifications order alerts channels',
    ar: 'احداث الاشعارات تنبيهات الطلبات قنوات',
  }),
  // ── Visual editor (/builder): one entry per control the editor added (Tasks 1-10) ─────────
  // The deep link is `?select=<sectionId|type|theme|history>&block=&field=<id>&page=<kind>`; the
  // builder selects on the canvas + tree and rings the control (Task 11). `query` carries the rest
  // of the link, the entry id is the `field`.
  ...(
    [
      // [id, labelKey, query, en synonyms, ar synonyms]
      [
        'builder.header-logo',
        'builder.theme.headerLogo',
        'select=theme',
        'logo position centre center start header wordmark',
        'مكان الشعار اللوجو منتصف بداية الهيدر',
      ],
      [
        'builder.card-brand-badge',
        'builder.theme.cardBrandBadge',
        'select=theme',
        'store name badge pill brand product card',
        'اسم المتجر شارة العلامة كارت المنتج',
      ],
      [
        'builder.card-new-badge',
        'builder.theme.cardNewBadge',
        'select=theme',
        'new badge chip product card latest',
        'شارة جديد كارت المنتج',
      ],
      [
        'builder.card-quick-add',
        'builder.theme.cardQuickAdd',
        'select=theme',
        'quick add plus cart carousel one tap',
        'اضافة سريعة سلة كاروسيل',
      ],
      [
        'builder.card-even-images',
        'builder.theme.cardEvenImages',
        'select=theme',
        'normalize product images same size crop cover grid',
        'توحيد صور المنتجات مقاس قص شبكة',
      ],
      [
        'builder.card-sale-corner',
        'builder.theme.cardSaleCorner',
        'select=theme',
        'sale badge discount corner position old',
        'شارة الخصم ركن مكان',
      ],
      [
        'builder.header-search',
        'builder.theme.headerSearch',
        'select=theme',
        'search field icon header find products',
        'البحث خانة بحث ايقونة الهيدر',
      ],
      [
        'builder.header-wordmark',
        'builder.theme.headerWordmark',
        'select=theme',
        'wordmark lockup store name logo designed plain header brand',
        'كلمة اسم المتجر شعار لوجو متصمم عادي الهيدر',
      ],
      [
        'builder.card-heart',
        'builder.theme.cardHeart',
        'select=theme',
        'wishlist heart favourite button card home hide show',
        'قلب المفضلة زر الكارت الرئيسية اخفاء اظهار',
      ],
      [
        'builder.card-swatches',
        'builder.theme.cardSwatches',
        'select=theme',
        'colour dots swatches card variants home hide show',
        'نقط الالوان الكارت الرئيسية اخفاء اظهار',
      ],
      [
        'builder.card-tags',
        'builder.theme.cardTags',
        'select=theme',
        'tag chips labels material card home hide show',
        'شارات تصنيف الخامة الكارت الرئيسية اخفاء اظهار',
      ],
      [
        'builder.grid-gutter',
        'builder.theme.gridGutter',
        'select=theme',
        'grid gutter gap spacing space between cards home tight airy',
        'مسافة فاصل بين الكروت الرئيسية ضيقة واسعة الشبكة',
      ],
      [
        'builder.heading-weight',
        'builder.theme.headingWeight',
        'select=theme',
        'heading weight bold regular section title typography',
        'سمك عناوين الاقسام عريض عادي خط العنوان',
      ],
      [
        'builder.price-colour',
        'builder.theme.priceColour',
        'select=theme',
        'price colour accent text card product',
        'لون السعر اللون المميز النص الكارت المنتج',
      ],
      [
        'builder.tab-bar',
        'builder.theme.tabBar',
        'select=theme',
        'bottom tab bar navigation phone home cart bag hide show',
        'الشريط السفلي التبويبات الموبايل الرئيسية السلة شنطة اخفاء اظهار',
      ],
      [
        'builder.hero-ratio',
        'builder.theme.heroRatio',
        'select=theme',
        'hero height ratio tall portrait square wide banner image phone',
        'طول الهيرو نسبة بورتريه مربع عريض البانر الصورة الرئيسية الموبايل',
      ],
      [
        'builder.fonts',
        'builder.search.fonts',
        'select=theme',
        'font typeface upload arabic english heading body',
        'خط خطوط حروف رفع عربي انجليزي عناوين',
      ],
      [
        'builder.typography-zones',
        'builder.search.typographyZones',
        'select=theme',
        'text size weight heading body button zone typography',
        'حجم الكتابة سمك عناوين ازرار منطقة خطوط',
      ],
      [
        'builder.section-typography',
        'builder.search.sectionTypography',
        'select=hero',
        'section font size heading colour typography',
        'خط القسم حجم لون العنوان كتابة',
      ],
      [
        'builder.dividers',
        'builder.search.dividers',
        'select=hero',
        'divider line ornament kicker lines separator',
        'فاصل خط زخرفة سطر',
      ],
      [
        'builder.section-spacing',
        'builder.search.spacing',
        'select=hero',
        'spacing padding margin gap above below tablet mobile desktop device',
        'مسافات مسافة فوق تحت تابلت موبايل كمبيوتر جهاز',
      ],
      [
        'builder.video',
        'builder.search.video',
        'select=hero&block=slide',
        'hero video background mp4 clip slide',
        'فيديو خلفية البانر مقطع شريحة',
      ],
      [
        'builder.page-settings',
        'builder.pageSettings.open',
        'page=product',
        'page settings product collection cart background spacing',
        'اعدادات الصفحة المنتج التصنيف السلة خلفية مسافات',
      ],
      [
        'builder.page-switcher',
        'builder.search.pageSwitcher',
        '',
        'switch page product collection cart home preview',
        'بدل الصفحة المنتج التصنيف السلة الرئيسية معاينة',
      ],
      [
        'builder.look-switch',
        'builder.look.title',
        '',
        'change look style template preview apply',
        'غيّر الشكل الستايل القالب معاينة تطبيق',
      ],
      [
        'builder.ai-patch',
        'builder.tabs.ai',
        'select=ai',
        'ask ai edit page change describe assistant patch',
        'اسأل الذكاء الاصطناعي تعديل الصفحة تغيير وصف مساعد',
      ],
      [
        'builder.history',
        'builder.tabs.history',
        'select=history',
        'history versions restore undo revisions',
        'السجل النسخ استعادة رجوع',
      ],
      [
        'builder.add-section',
        'builder.addSection.title',
        '',
        'add section block new row',
        'اضافة قسم جديد',
      ],
    ] as const
  ).map(([id, labelKey, query, en, ar]) =>
    setting(id, '/builder', labelKey, 'staff', { en, ar }, query ? { query } : {})
  ),
];

export const REGISTRY: RegistryEntry[] = [...PAGES, ...SETTINGS];

/**
 * Ratchet for the coverage gate on controls: the number of labelled controls (`<label>`, `<Label>`, `<legend>`, `<Toggle>`,
 * `<FormField>`) per settings page directory at the time the registry was last reviewed. Adding a labelled control to one of these
 * pages raises the count and fails `settings-registry.test.ts` until a registry entry (and
 * `data-setting-id` anchor) is added and the number is raised in the same change. Lowering it is
 * always allowed. Keys are paths under `apps/admin/src/app/stores/[id]`.
 */
export const SETTINGS_LABEL_BASELINE: Record<string, number> = {
  '/ai-usage': 0, // the switch is a component (components/ai/AiSwitchCard), anchored ai.switch
  '/branding': 43,
  '/builder': 29, // the visual editor: panels are generated from the registry; the header chrome controls are anchored builder.header-*
  '/delivery': 14,
  '/shipping': 22, // T4: first-run card (fee, free-over)
  '/payment-settings': 24, // +6: the instalments card (enable, months, markup, provider ar/en, min price), anchored payment.instalments
  '/tax': 16,
  '/pwa': 14, // T4: the on/off switch moved from the header into the body
  '/language': 0,
  '/domain': 1,
  '/seo': 24,
  '/floating-widget': 26,
  '/blog': 9, // T4: the blog on/off card moved here from branding
  '/content/faqs': 13, // T4: moved from the SEO page
  '/notifications': 10, // T4: the web-push switch moved here from branding
};
