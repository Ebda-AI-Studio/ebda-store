import type { Metadata } from 'next';
import { BRAND } from '@force/shared/brand';
import { COPY } from './content';
import { HOME, SIGNUP_URL, SITE_URL, absoluteUrl, pagePath, type Locale } from './site';

type Page = '' | 'legal' | 'privacy' | 'terms';

const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Ebda · ابدأ — Nile at night, each light is a store',
};

/** Metadata for a page in a locale, incl. canonical + hreflang alternates. */
export function pageMetadata(
  locale: Locale,
  page: Page,
  title?: string,
  description?: string
): Metadata {
  const c = COPY[locale];
  const t = title ?? c.meta.title;
  const d = description ?? c.meta.description;
  const languages: Record<string, string> = {
    ar: pagePath('ar', page),
    en: pagePath('en', page),
    'x-default': pagePath('ar', page),
  };
  return {
    metadataBase: new URL(SITE_URL),
    title: t,
    description: d,
    alternates: { canonical: pagePath(locale, page), languages },
    openGraph: {
      type: 'website',
      siteName: `${BRAND.name} · ${BRAND.nameAr}`,
      title: t,
      description: d,
      url: pagePath(locale, page),
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_EG'],
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: t, description: d, images: [OG_IMAGE.url] },
    icons: { icon: '/icon.svg' },
    robots: { index: true, follow: true },
  };
}

/** JSON-LD graph: Organization + WebSite + SoftwareApplication. No ratings or offers (pricing undecided). */
export function jsonLd(locale: Locale) {
  const c = COPY[locale];
  const org = `${SITE_URL}/#organization`;
  const site = `${SITE_URL}/#website`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: BRAND.name,
        alternateName: BRAND.nameAr,
        url: SITE_URL,
        logo: `${SITE_URL}/icon.svg`,
        email: BRAND.supportEmail,
        parentOrganization: { '@type': 'Organization', name: BRAND.company },
      },
      {
        '@type': 'WebSite',
        '@id': site,
        url: absoluteUrl(HOME[locale]),
        name: BRAND.name,
        inLanguage: locale,
        publisher: { '@id': org },
      },
      {
        '@type': 'SoftwareApplication',
        name: BRAND.name,
        alternateName: BRAND.nameAr,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: c.meta.description,
        url: SIGNUP_URL,
        installUrl: SIGNUP_URL,
        publisher: { '@id': org },
        inLanguage: ['ar', 'en'],
      },
    ],
  };
}
