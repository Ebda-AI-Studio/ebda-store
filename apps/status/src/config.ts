// The probe list. Edit this file to add or change a monitored component; nothing else is
// needed. Hosts come from the shared brand constants (pure data) so a domain change is made once.
import { BRAND } from '../../../packages/shared/src/brand/index';
import type { ComponentConfig, Localized } from './types';

const d = BRAND.domains;

/**
 * The products the page groups components under (BRAND-ARCH-1: components per product). A product is listed here
 * when it is LIVE; Ebda WhatsApp / CRM / ERP get a group (and their probes) the day they ship, never a placeholder.
 */
export const PRODUCTS: readonly { id: string; name: Localized }[] = [
  { id: 'store', name: { en: BRAND.product.nameEn, ar: BRAND.product.nameAr } },
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
    url: `https://storedemo-souq${d.storeSuffix}/`,
    expectStatus: 200,
    expectBody: 'data-zone=',
  },
  {
    id: 'storefront-product',
    product: 'store',
    name: { en: 'Storefront product pages', ar: 'صفحات المنتجات في المتاجر' },
    // A product page renders through a different route than the home page (one returned a one-off 500, audit UI-7),
    // so it is probed on its own: the seeded Lamma demo product. `data-zone=` as above.
    url: `https://storedemo-lamma${d.storeSuffix}/products/mahshi-koronb`,
    expectStatus: 200,
    expectBody: 'data-zone=',
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

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_FAIL_THRESHOLD = 3;
export const DEFAULT_RECOVER_THRESHOLD = 2;
/** Days of daily rollups kept and shown. */
export const HISTORY_DAYS = 90;
