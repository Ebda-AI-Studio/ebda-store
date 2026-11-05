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
 * The map is grouped by PRODUCT (Ebda Store live; WhatsApp / CRM / ERP coming soon), then help and contact.
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

export const NOT_FOUND: Record<Locale, NotFoundCopy> = {
  ar: {
    line: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده، أو اختار قسم من تحت.',
    searchLabel: 'دوّر في الموقع',
    searchPlaceholder: 'دوّر في الموقع والمساعدة والوثائق',
    searchButton: 'بحث',
    mapLabel: 'خريطة الموقع',
    soon: 'قريباً',
    phoneCaption: 'جرّب متجر تجريبي',
    groups: [
      {
        title: BRAND.company.shortNameAr,
        links: [
          { href: HOME.ar, label: 'الرئيسية' },
          { href: pagePath('ar', 'about'), label: 'عن ابدأ ستوديو' },
          { href: pagePath('ar', 'contact'), label: 'تواصل معانا' },
        ],
      },
      {
        title: BRAND.product.nameAr,
        links: [
          { href: pagePath('ar', 'features'), label: 'المميزات' },
          { href: `${STORE_HOME.ar}#pricing`, label: 'الأسعار' },
          { href: SIGNUP_URL, label: 'ابدأ متجرك' },
          { href: LOGIN_URL, label: 'دخول' },
          { href: demo, label: 'متجر تجريبي' },
        ],
      },
      {
        title: 'قريباً',
        links: [
          { href: '', label: 'ابدأ شات', soon: true },
          { href: '', label: 'ابدأ CRM', soon: true },
          { href: '', label: 'ابدأ ERP', soon: true },
        ],
      },
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
          { href: SIGNUP_URL, label: 'Start your store' },
          { href: LOGIN_URL, label: 'Log in' },
          { href: demo, label: 'Demo store' },
        ],
      },
      {
        title: 'Coming soon',
        links: [
          { href: '', label: 'Ebda Chat', soon: true },
          { href: '', label: 'Ebda CRM', soon: true },
          { href: '', label: 'Ebda ERP', soon: true },
        ],
      },
      {
        title: 'Help',
        links: [
          { href: `${help}/en/`, label: 'Help center' },
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
