import type { MetadataRoute } from 'next';
import { LOCALES, SITE_URL, pagePath } from '@/lib/site';

export const dynamic = 'force-static';

const PAGES = ['', 'legal', 'privacy', 'terms'] as const;
const abs = (p: string) => (p === '/' ? `${SITE_URL}/` : `${SITE_URL}${p}/`);

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.flatMap(page =>
    LOCALES.map(locale => ({
      url: abs(pagePath(locale, page)),
      changeFrequency: page === '' ? ('weekly' as const) : ('yearly' as const),
      priority: page === '' ? 1 : 0.3,
      alternates: {
        languages: Object.fromEntries(LOCALES.map(l => [l, abs(pagePath(l, page))])),
      },
    }))
  );
}
