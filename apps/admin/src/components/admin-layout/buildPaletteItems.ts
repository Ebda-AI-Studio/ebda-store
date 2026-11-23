import type { NavItem } from './buildStoreAdminNav';
import { HUBS, type HubLabels } from './hubs';
import type { HubTab } from './HubTabs';

/**
 * A single searchable destination in the ⌘K command palette.
 * `group` is the hub/section it belongs to (e.g. "Catalog", "Settings") and is
 * shown as context + included in the fuzzy search so typing "stock" surfaces
 * every Inventory page even if the page's own name doesn't contain it.
 */
export interface PaletteItem {
  name: string;
  href: string;
  group?: string;
  icon?: string;
  /** Bilingual synonyms/related terms folded into the search haystack so a
   *  concept word (e.g. "logo" / "شعار") finds the page even when the page's
   *  own name doesn't contain it. */
  keywords?: string;
  /**
   * Set on admin-search registry entries (lib/settings-search.ts). A single `setting` is listed
   * only once the user types, so the empty palette stays the short list of hubs and pages.
   */
  kind?: 'page' | 'setting';
}

// Concept synonyms per page, EN + AR, keyed by the LAST path segment of the
// href. Lets the palette match by what a page CONTAINS, not just its title —
// e.g. "logo"/"شعار" → Branding, "paymob"/"فوري" → Payment settings. Matching is
// Arabic-folded in the palette, so unvowelled/variant Arabic still hits.
const PAGE_KEYWORDS: Record<string, string> = {
  branding:
    'logo brand colors color palette favicon theme appearance look font شعار لوجو علامة هوية ألوان الوان لون مظهر شكل خط أيقونة',
  seo: 'seo search engine meta title description google keywords sitemap سيو محركات البحث جوجل وصف كلمات مفتاحية عنوان',
  domain: 'domain url web address custom domain dns website link نطاق دومين رابط عنوان موقع ويب',
  'payment-settings':
    'payment gateway checkout paymob kashier fawry instapay meeza wallet valu card cod دفع بوابة باي موب كاشير فوري إنستاباي ميزة محفظة فاليو بطاقة الدفع عند الاستلام',
  shipping: 'delivery rates zones courier areas governorate شحن توصيل مناطق محافظة أسعار شركة شحن',
  tax: 'vat taxes ضريبة ضرائب القيمة المضافة',
  pwa: 'app install mobile icon manifest progressive تطبيق جوال أيقونة تثبيت',
  qr: 'qr code barcode label scan print poster flyer sticker كود كيو ار باركود ملصق مسح طباعة',
  template: 'theme design layout template skin قالب تصميم تخطيط مظهر',
  language: 'translation arabic english locale rtl لغة ترجمة عربي انجليزي اتجاه',
  staff: 'team members roles permissions users access موظفين فريق صلاحيات أدوار مستخدمين وصول',
  announcement: 'banner bar top message strip إعلان شريط رسالة علوي',
  billing:
    'plan subscription upgrade usage limits invoice باقة اشتراك ترقية استخدام حدود فاتورة فوترة',
  builder:
    'design layout sections hero homepage visual editor builder تصميم تخطيط أقسام الصفحة الرئيسية بانر محرر مرئي منشئ',
  products: 'catalog items inventory skus goods منتجات سلع بضائع كتالوج',
  categories: 'collections groups فئات تصنيفات مجموعات أقسام',
  'size-charts':
    'size guide chart measurements fit abaya ring دليل المقاسات جدول مقاسات مقاس قياسات عباية خاتم',
  content: 'pages static about contact صفحات محتوى من نحن اتصل',
  blog: 'posts articles news مدونة مقالات أخبار',
  'floating-widget': 'chat button float whatsapp زر عائم دردشة',
  navigation: 'menu links nav header قائمة تنقل روابط',
  orders: 'sales purchases checkout invoices طلبات مبيعات فواتير',
  invoices: 'tax invoice receipt credit note refund vat فواتير فاتورة ضريبية إشعار دائن إيصال',
  customers: 'clients buyers crm contacts عملاء زبائن جهات اتصال',
  reviews: 'ratings feedback stars مراجعات تقييمات نجوم',
  returns: 'refunds exchanges rma إرجاع استرجاع استبدال',
  coupons: 'discounts promo codes vouchers كوبونات خصومات أكواد قسائم',
  promotions: 'automatic discounts sale deals عروض ترويجية خصومات تلقائية عروض',
  loyalty: 'points rewards tiers نقاط مكافآت ولاء',
  bundles: 'kits combos sets product bundles باقات مجموعات عروض مجمعة',
  wallet: 'store credit balance refund wallet محفظة رصيد المتجر رصيد استرداد',
  inventory: 'stock quantity warehouse مخزون كمية مستودع جرد',
  warehouses: 'locations stores depot مستودعات مخازن مواقع',
  suppliers: 'vendors purchasing موردين بائعين شراء',
  'purchase-orders': 'po buying restock أوامر شراء توريد',
  backorders: 'preorder out of stock طلب مسبق نفد المخزون',
  reorder: 'reorder point low stock نقطة إعادة الطلب',
  accounts: 'chart of accounts ledger دليل الحسابات دفتر',
  journal: 'entries bookkeeping قيود يومية محاسبة',
  expenses: 'costs spending bills مصروفات نفقات فواتير',
  reports: 'financial statements pnl تقارير قوائم مالية أرباح',
  analytics: 'reports stats metrics insights traffic تحليلات تقارير إحصائيات زيارات',
  'ai-tools': 'ai gemini translate seo bulk autofill ذكاء اصطناعي ترجمة تعبئة تلقائية',
  notifications: 'push alerts onesignal إشعارات تنبيهات',
  newsletter: 'email campaign broadcast نشرة بريدية حملة بريد',
  campaigns: 'email campaign newsletter marketing send حملات بريد تسويق نشرة إرسال',
  'abandoned-carts': 'cart recovery abandoned سلة متروكة استرداد',
  'marketing-pixels': 'facebook tiktok snapchat google ads tracking بكسل تتبع إعلانات',
  'product-feeds':
    'google merchant center shopping meta commerce catalog tiktok feed كتالوج خلاصة منتجات',
  affiliates: 'referral partners commission تسويق بالعمولة شركاء إحالة',
  whatsapp: 'wa chat messaging catalog واتساب رسائل دردشة',
  'agent-key':
    'ai agent mcp key credential token chatgpt claude agentic checkout api key مفتاح وكيل ذكاء اصطناعي بيانات اعتماد رمز شراء تلقائي',
};

/** Pull the keyword string for a page from its href's final path segment. */
export function keywordsForHref(href: string): string | undefined {
  const seg = href.split('/').filter(Boolean).pop() ?? '';
  return PAGE_KEYWORDS[seg];
}

/** Labels for the Settings sub-pages (no hub tab bar, so not in hubs.ts). */
export interface SettingsPaletteLabels {
  branding: string;
  seo: string;
  domain: string;
  payments: string;
  shipping: string;
  tax: string;
  pwa: string;
  qr: string;
  template: string;
  language: string;
  staff: string;
  announcement: string;
  agentKey: string;
  merchantKeys: string;
  webhooks: string;
  billing: string;
}

/**
 * Build the FULL searchable destination list for a store-admin context — not
 * just the ~8 sidebar hubs, but every page reachable inside them (hub tabs) plus
 * the Settings sub-pages. Respects role/feature gating implicitly: a hub's tabs
 * are only included when that hub survived the sidebar's `navItems` filter, so a
 * staff user (no Settings/Finance hub) never sees those pages in search.
 */
export function buildStorePaletteItems(
  navItems: NavItem[],
  storeId: string,
  hubLabels: HubLabels,
  settings: SettingsPaletteLabels,
  /** Same gate the hub tab bar applies to feature-keyed tabs. */
  isTabVisible: (tab: HubTab) => boolean = () => true
): PaletteItem[] {
  const items: PaletteItem[] = [];

  // 1. The visible hubs themselves (Dashboard, Catalog, Sales, …).
  for (const n of navItems) {
    items.push({
      name: n.name,
      href: n.href,
      icon: n.icon,
      group: n.name,
      keywords: keywordsForHref(n.href),
    });
  }

  // hubKey → display name, from the already-gated nav items.
  const hubNameByKey = new Map<string, string>();
  for (const n of navItems) if (n.hubKey) hubNameByKey.set(n.hubKey, n.name);

  // 2. Every tab inside each VISIBLE hub (skip hubs the user can't see).
  for (const hub of HUBS) {
    const group = hubNameByKey.get(hub.key);
    if (!group) continue;
    for (const tab of hub.buildTabs(storeId, hubLabels)) {
      if (!isTabVisible(tab)) continue;
      items.push({ name: tab.label, href: tab.href, group, keywords: keywordsForHref(tab.href) });
    }
  }

  // 3. Settings sub-pages (cards, not tabs) — only when the Settings hub is
  //    visible (super_admin / store_admin, never staff).
  const settingsGroup = hubNameByKey.get('settings');
  if (settingsGroup) {
    const pages: Array<[string, string]> = [
      [settings.branding, `/stores/${storeId}/branding`],
      [settings.announcement, `/stores/${storeId}/announcement`],
      [settings.seo, `/stores/${storeId}/seo`],
      [settings.domain, `/stores/${storeId}/domain`],
      [settings.payments, `/stores/${storeId}/payment-settings`],
      [settings.shipping, `/stores/${storeId}/shipping`],
      [settings.tax, `/stores/${storeId}/tax`],
      [settings.pwa, `/stores/${storeId}/pwa`],
      [settings.qr, `/stores/${storeId}/codes`],
      [settings.template, `/stores/${storeId}/builder`],
      [settings.language, `/stores/${storeId}/language`],
      [settings.staff, `/stores/${storeId}/staff`],
      [settings.agentKey, `/stores/${storeId}/agent-key`],
      [settings.merchantKeys, `/stores/${storeId}/merchant-keys`],
      [settings.webhooks, `/stores/${storeId}/webhooks`],
      [settings.billing, `/stores/${storeId}/billing`],
    ];
    for (const [name, href] of pages)
      items.push({ name, href, group: settingsGroup, keywords: keywordsForHref(href) });
  }

  // Dedupe by href (a page could appear as both a hub landing + a tab).
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.href) ? false : (seen.add(i.href), true)));
}
