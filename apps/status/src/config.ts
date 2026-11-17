// The probe list. Edit this file to add or change a monitored component; nothing else is
// needed. Hosts come from the shared brand constants (pure data) so a domain change is made once.
import { BRAND } from '../../../packages/shared/src/brand/index';
import type { ComponentConfig, Localized } from './types';

const d = BRAND.domains;

/**
 * The products the page groups components under (BRAND-ARCH-1: components per product). A product is listed here
 * when it is LIVE; CRM / ERP get a group (and their probes) the day they ship, never a placeholder. Ebda Chat is live
 * (wa.ebda.app, LAUNCH-SUITE-1), so it has its group and probe (content audit C6, 2026-11-10).
 */
export const PRODUCTS: readonly { id: string; name: Localized }[] = [
  { id: 'store', name: { en: BRAND.product.nameEn, ar: BRAND.product.nameAr } },
  { id: 'chat', name: { en: BRAND.productWhatsapp.nameEn, ar: BRAND.productWhatsapp.nameAr } },
  { id: 'studio', name: { en: BRAND.company.shortNameEn, ar: BRAND.company.shortNameAr } },
];

export const COMPONENTS: readonly ComponentConfig[] = [
  {
    id: 'marketing',
    product: 'studio',
    name: { en: 'Marketing site', ar: 'الموقع الرئيسي' },
    url: `https://${d.marketing}/`,
    expectStatus: 200,
    expectBody: 'ebda|ابدأ',
  },
  {
    id: 'admin',
    product: 'store',
    name: { en: 'Merchant dashboard', ar: 'لوحة التحكم' },
    url: `https://${d.storeApp}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'orders',
    product: 'store',
    name: { en: 'Orders app', ar: 'تطبيق الطلبات' },
    url: `https://${d.orders}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'accounts',
    product: 'store',
    name: { en: 'Sign-in (accounts)', ar: 'تسجيل الدخول' },
    url: `https://accounts.${d.marketing}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'api',
    product: 'store',
    name: { en: 'API', ar: 'واجهة البرمجة' },
    url: `https://${d.api}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'storefront',
    product: 'store',
    name: { en: 'Storefronts', ar: 'المتاجر' },
    // A demo store we control and seed (apps/marketing DEMO_STORES, scripts/storedemo/seed.mjs) stands in for every
    // `<slug>.ebda.app` storefront; it exists whatever merchants do. `data-zone=` is rendered by a real storefront
    // template and is absent from the unknown-store 404 page, so a missing store cannot pass as "up".
    // The canonical `/ar` URL, not `/`: `/` is a 308 to `/ar` (LOCALE-REDIRECT-EDGE-1), a second Worker round trip that
    // measured 41 % of the total (hop1 p50 0.68 s / p90 2.3 s vs page p50 0.61 s, 2026-11-15) and doubled the cold-isolate
    // exposure of one probe, so two cold starts in a row read as a "slow" page. Real visitors arrive on `/ar` links
    // (sitemap, canonical, hreflang). The redirect itself is covered by tests/unit/locale-redirect-edge.test.ts.
    url: `https://storedemo-souq${d.storeSuffix}/ar`,
    expectStatus: 200,
    expectBody: 'data-zone=',
  },
  {
    id: 'storefront-product',
    product: 'store',
    name: { en: 'Storefront product pages', ar: 'صفحات المنتجات في المتاجر' },
    // A product page renders through a different route than the home page (one returned a one-off 500, audit UI-7),
    // so it is probed on its own: the seeded Lamma demo product. `data-zone=` as above.
    // `/ar/...` for the same reason as `storefront` above (the unprefixed URL is a 308 hop).
    url: `https://storedemo-lamma${d.storeSuffix}/ar/products/mahshi-koronb`,
    expectStatus: 200,
    expectBody: 'data-zone=',
  },
  {
    id: 'chat',
    product: 'chat',
    name: { en: 'Ebda Chat app', ar: 'تطبيق ابدأ شات' },
    // The Ebda Chat Worker's own health route (repo Ebda-AI-Studio/ebda-whatsapp): `{"ok":true,"status":"ok",...}`.
    url: `https://${d.whatsappApp}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'docs',
    product: 'studio',
    name: { en: 'Developer docs', ar: 'وثائق المطوّرين' },
    url: `https://${d.docs}/`,
    expectStatus: 200,
    expectBody: 'ebda',
  },
  {
    id: 'help',
    product: 'studio',
    name: { en: 'Help centre', ar: 'مركز المساعدة' },
    url: `https://${d.help}/`,
    expectStatus: 200,
    expectBody: 'ebda|ابدأ',
  },
];

/**
 * Hard deadline for one probe. 15 s, not 8 s: in quiet hours a cold isolate answers a storefront page in 2-12 s
 * (measured 2026-11-14/15, worker ebda-web: p50 2-4 s, p99 6-12 s), which is SLOW, not DOWN.
 */
export const DEFAULT_TIMEOUT_MS = 15000;
/** A successful probe slower than this is `degraded` (shown, never paged); two in a row open an incident. */
export const SLOW_THRESHOLD_MS = 8000;
/** Consecutive slow probes that count as one failure. */
export const SLOW_STREAK_FAILS = 2;
export const DEFAULT_FAIL_THRESHOLD = 2;
export const DEFAULT_RECOVER_THRESHOLD = 1;
/** Days of daily rollups kept and shown. */
export const HISTORY_DAYS = 90;
