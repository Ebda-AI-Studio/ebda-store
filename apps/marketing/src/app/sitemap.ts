import type { MetadataRoute } from 'next';
import { LEGAL_SLUGS, LOCALES, SITE_URL, SITE_PAGES, pagePath } from '@/lib/site';
import { LEGAL_UPDATED } from '@/lib/content';

export const dynamic = 'force-static';

const abs = (p: string) => (p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p}/`);

/** Product pages (features, comparisons) rank above the legal pages. */
const marketing = (page: string) => page === 'features' || page.startsWith('compare/');

/**
 * Date the non-legal page content last changed. Bump it in the PR that changes page copy: lastmod was the
 * build time on every page, so every deploy marked all pages changed. Legal pages use their own
 * published date (LEGAL_UPDATED), so a features edit no longer re-dates the privacy policy.
 */
const CONTENT_UPDATED = '2026-10-22';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModifiedFor = (page: string) =>
    new Date(
      (LEGAL_SLUGS as readonly string[]).includes(page) ? String(LEGAL_UPDATED) : CONTENT_UPDATED
    );
  return SITE_PAGES.flatMap(page =>
    LOCALES.map(locale => ({
      url: abs(pagePath(locale, page)),
      lastModified: lastModifiedFor(page),
      changeFrequency:
        page === ''
          ? ('weekly' as const)
          : marketing(page)
            ? ('monthly' as const)
            : ('yearly' as const),
      priority: page === '' ? 1 : marketing(page) ? 0.8 : 0.3,
      alternates: {
        languages: {
          ...Object.fromEntries(LOCALES.map(l => [l, abs(pagePath(l, page))])),
          'x-default': abs(pagePath('ar', page)),
        },
      },
    }))
  );
}
