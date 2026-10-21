import type { MetadataRoute } from 'next';
import { LOCALES, SITE_URL, SITE_PAGES, pagePath } from '@/lib/site';

export const dynamic = 'force-static';

const abs = (p: string) => (p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p}/`);

/** Product pages (features, comparisons) rank above the legal pages. */
const marketing = (page: string) => page === 'features' || page.startsWith('compare/');

export default function sitemap(): MetadataRoute.Sitemap {
  // Static export: evaluated once at build, so this is the build time.
  const lastModified = new Date();
  return SITE_PAGES.flatMap(page =>
    LOCALES.map(locale => ({
      url: abs(pagePath(locale, page)),
      lastModified,
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
