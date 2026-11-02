import type { MetadataRoute } from 'next';
import {
  LEGAL_EXTRA_SLUGS,
  LEGAL_SLUGS,
  LOCALES,
  SITE_URL,
  SITE_PAGES,
  pagePath,
} from '@/lib/site';
import { LEGAL_UPDATED } from '@/lib/content';
import lastmod from '@/lib/page-lastmod.json';

export const dynamic = 'force-static';

const abs = (p: string) => (p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p}/`);

/** Product pages (features, Ebda Chat, comparisons) rank above the legal pages. */
const marketing = (page: string) =>
  page === 'features' || page === 'whatsapp' || page.startsWith('compare/');

/**
 * <lastmod> is real: non-legal pages take the date recorded in page-lastmod.json, which is tied to a hash of the
 * page's rendered markup (`npm run lastmod -w apps/marketing` re-dates exactly the pages that changed; a unit test
 * fails until you run it). Legal pages use their own published date (LEGAL_UPDATED).
 */
const DATES = lastmod as Record<string, { hash: string; date: string }>;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModifiedFor = (page: string) =>
    new Date(
      ([...LEGAL_SLUGS, ...LEGAL_EXTRA_SLUGS] as readonly string[]).includes(page)
        ? String(LEGAL_UPDATED)
        : (DATES[page || 'home']?.date ??
            (() => {
              throw new Error(`page-lastmod.json has no entry for "${page}": run npm run lastmod`);
            })())
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
