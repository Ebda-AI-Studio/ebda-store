import { BRAND } from '@ebda/shared/brand';
import {
  HOME,
  STORE_HOME,
  LOGIN_URL,
  SIGNUP_URL,
  demoLookUrl,
  pagePath,
  type Locale,
} from './site';

/**
 * The 404's words and links, both languages (Egyptian Arabic in full sentences). One static 404.html serves
 * every path, so the page carries both and a tiny inline script shows the one matching the URL (/en/...).
 * The map is grouped by PRODUCT (Ebda Store and Ebda Chat live; the coming-soon list is `BRAND.comingProducts`, never a
 * hand-written list, so it cannot drift from the home page and nav: content audit C1/C2), then help and contact.
 * Ebda Chat is LIVE at wa.ebda.app: never list it as coming soon.
 */
export interface NotFoundLink {
  href: string;
  label: string;
  soon?: boolean;
}
export interface NotFoundGroup {
  title: string;
  links: NotFoundLink[];
}
export interface NotFoundCopy {
  line: string;
  hint: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchButton: string;
  mapLabel: string;
  soon: string;
  phoneCaption: string;
  groups: NotFoundGroup[];
}

const help = `https://${BRAND.domains.help}`;
const docs = `https://${BRAND.domains.docs}`;
const status = `https://${BRAND.domains.status}`;
const demo = demoLookUrl('souq', 'catalogue');
const chatApp = `https://${BRAND.domains.whatsappApp}/`;
/** The coming-soon products, straight from BRAND (names only; they have no page to link yet). */
const comingSoon = (lang: Locale): NotFoundLink[] =>
  BRAND.comingProducts.map(p => ({
    href: '',
    label: lang === 'ar' ? p.nameAr : p.nameEn,
    soon: true,
  }));

export const NOT_FOUND: Record<Locale, NotFoundCopy> = {
  ar: {
    line: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده، أو اختار قسم من تحت.',
    searchLabel: 'دوّر في الموقع',
    searchPlaceholder: 'دوّر في الموقع والمساعدة والوثائق',
    searchButton: 'بحث',
    mapLabel: 'خريطة الموقع',
    soon: 'قريبًا',
    phoneCaption: 'جرّب متجر تجريبي',
    groups: [
      {
        title: BRAND.company.shortNameAr,
        links: [
          { href: HOME.ar, label: 'الرئيسية' },
          { href: pagePath('ar', 'about'), label: 'عن الستوديو' },
          { href: pagePath('ar', 'contact'), label: 'تواصل معنا' },
        ],
      },
      {
        title: BRAND.product.nameAr,
        links: [
          { href: pagePath('ar', 'features'), label: 'المميزات' },
          { href: `${STORE_HOME.ar}#pricing`, label: 'الأسعار' },
          { href: SIGNUP_URL, label: 'افتح متجرك' },
          { href: LOGIN_URL, label: 'دخول' },
          { href: demo, label: 'متجر تجريبي' },
        ],
      },
      {
        title: BRAND.productWhatsapp.nameAr,
        links: [
          { href: pagePath('ar', 'whatsapp'), label: 'إزاي بيشتغل' },
          { href: chatApp, label: `ادخل على ${BRAND.productWhatsapp.nameAr}` },
        ],
      },
      { title: 'قريبًا', links: comingSoon('ar') },
      {
        title: 'المساعدة',
        links: [
          { href: help, label: 'مركز المساعدة' },
          { href: docs, label: 'وثائق المطوّرين' },
          { href: status, label: 'حالة الخدمة' },
        ],
      },
    ],
  },
  en: {
    line: "The page you're looking for can't be found.",
    hint: 'Search for what you meant, or pick a section below.',
    searchLabel: 'Search the site',
    searchPlaceholder: 'Search the site, help and docs',
    searchButton: 'Search',
    mapLabel: 'Site map',
    soon: 'Coming soon',
    phoneCaption: 'Try a demo store',
    groups: [
      {
        title: BRAND.company.shortNameEn,
        links: [
          { href: HOME.en, label: 'Home' },
          { href: pagePath('en', 'about'), label: 'About the studio' },
          { href: pagePath('en', 'contact'), label: 'Contact' },
        ],
      },
      {
        title: BRAND.product.nameEn,
        links: [
          { href: pagePath('en', 'features'), label: 'Features' },
          { href: `${STORE_HOME.en}#pricing`, label: 'Pricing' },
          { href: SIGNUP_URL, label: 'Open your store' },
          { href: LOGIN_URL, label: 'Log in' },
          { href: demo, label: 'Demo store' },
        ],
      },
      {
        title: BRAND.productWhatsapp.nameEn,
        links: [
          { href: pagePath('en', 'whatsapp'), label: 'How it works' },
          { href: chatApp, label: `Open ${BRAND.productWhatsapp.nameEn}` },
        ],
      },
      { title: 'Coming soon', links: comingSoon('en') },
      {
        title: 'Help',
        links: [
          { href: `${help}/en/`, label: 'Help centre' },
          { href: docs, label: 'Developer docs' },
          { href: `${status}/en`, label: 'Service status' },
        ],
      },
    ],
  },
};

/** The indexes the live search reads (cross-origin help + docs allow it with CORS; marketing is same-origin). */
export const SEARCH_SOURCES: Record<Locale, { index: string; base: string }[]> = {
  ar: [
    { index: '/search-index.ar.json', base: '' },
    { index: `${help}/search-index.ar.json`, base: help },
    { index: `${docs}/search-index.en.json`, base: docs },
  ],
  en: [
    { index: '/search-index.en.json', base: '' },
    { index: `${help}/search-index.en.json`, base: help },
    { index: `${docs}/search-index.en.json`, base: docs },
  ],
};

/** The search form's `data-sources` value: bracket-free (`index|base;index|base`) so the page text stays placeholder-clean. */
export const sourcesAttr = (locale: Locale): string =>
  SEARCH_SOURCES[locale].map(s => `${s.index}|${s.base}`).join(';');
