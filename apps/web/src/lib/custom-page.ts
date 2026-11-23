import { API_URL } from './api';

/** Standard pages with their own storefront routes: never served by the generic /pages/<slug> route. Mirrors the API. */
export const STANDARD_PAGE_SLUGS: readonly string[] = [
  'home',
  'about',
  'privacy',
  'terms',
  'shipping',
  'faq',
  'legal',
  'returns',
  'refund',
  'cookies',
  'contact',
];

export interface PublicCustomPage {
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  coverImage?: string | null;
  contentHtml?: string | null;
  contentHtmlAr?: string | null;
  updatedAt?: string;
}

/**
 * A PUBLISHED custom page of THIS store, or null (no row, switched off, standard page, or nothing to show): the route 404s on null.
 * The store id comes from the resolved host, never from the URL, so another store's slug is simply absent here (null).
 * A transient API failure throws (a 5xx page, never a false 404 that would drop the URL from search).
 */
export async function fetchCustomPage(
  storeId: string,
  slug: string
): Promise<PublicCustomPage | null> {
  if (!storeId || storeId === 'demo') return null;
  const s = slug.trim().toLowerCase();
  if (!s || STANDARD_PAGE_SLUGS.includes(s)) return null;
  const res = await fetch(`${API_URL}/public/${storeId}/pages/${encodeURIComponent(s)}`, {
    headers: { 'X-Store-ID': storeId },
    next: { revalidate: 60, tags: [`pages:${storeId}`] },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`custom page fetch failed: ${res.status}`);
  const page = (await res.json())?.data?.page as PublicCustomPage | null | undefined;
  if (!page) return null;
  const hasBody = (page.contentHtml ?? '').trim() || (page.contentHtmlAr ?? '').trim();
  return hasBody ? page : null;
}

/** Plain text for a meta description: tags stripped, whitespace folded, cut at 160. */
export function metaDescriptionFrom(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text;
}
