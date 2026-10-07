// The probe list. Edit this file to add or change a monitored component; nothing else is
// needed. Hosts come from the shared brand constants (pure data) so a domain change is made once.
import { BRAND } from '../../../packages/shared/src/brand/index';
import type { ComponentConfig } from './types';

const d = BRAND.domains;

export const COMPONENTS: readonly ComponentConfig[] = [
  {
    id: 'marketing',
    name: { en: 'Marketing site', ar: 'الموقع الرئيسي' },
    url: `https://${d.marketing}/`,
    expectStatus: 200,
    expectBody: 'ebda|ابدأ',
  },
  {
    id: 'admin',
    name: { en: 'Merchant dashboard', ar: 'لوحة التحكم' },
    url: `https://${d.storeApp}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'api',
    name: { en: 'API', ar: 'واجهة البرمجة' },
    url: `https://${d.api}/health`,
    expectStatus: 200,
    expectBody: '"status":\\s*"ok"',
  },
  {
    id: 'storefront',
    name: { en: 'Storefronts', ar: 'المتاجر' },
    // Merchant #1's store host stands in for every `<slug>.ebda.app` storefront.
    url: `https://amelia${d.storeSuffix}/`,
    expectStatus: 200,
    expectBody: '<html',
  },
  {
    id: 'docs',
    name: { en: 'Developer docs', ar: 'وثائق المطوّرين' },
    url: `https://${d.docs}/`,
    expectStatus: 200,
    expectBody: 'ebda',
  },
  {
    id: 'help',
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
