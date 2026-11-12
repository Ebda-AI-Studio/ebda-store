import { localePathContext } from '../../../lib/seo/locale-alternates';
import { localizeJsonLdUrls } from '../../../lib/locale-paths';
import type { Metadata } from 'next';
import { permanentRedirect, notFound } from 'next/navigation';
import type { ResolvedStore } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import { fetchSlugRedirect, storeRedirectUrl } from '../../../lib/slug-redirect';
import { getSiteUrl, storeAbsoluteUrl } from '../../../lib/structured-data';
import { jsonLdScriptContent } from '../../../lib/json-ld-script';
import { BlogPostClient, type BlogDetail } from './BlogPostClient';

/**
 * Blog post body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both `app/blog/[slug]/page.tsx`
 * (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/blog/[slug]/page.tsx` (new, params-based,
 * dark-launched). See docs/plans/done/2026-07-12-tenant-cacheable-routing.md
 * §3.6/§9 — this is the one Track-A route the plan explicitly calls out as
 * needing the resolver swap (the blog index itself is a pure client shell).
 */

/**
 * Fetch a single blog post server-side. Returns null ONLY on a definitive
 * 404 (real miss) so the page can render the not-found / redirect-resolve
 * state; a transient error (5xx or network failure) throws so the page 500s
 * instead of being cached as a false 404 (F2 — was previously a client-only
 * 'use client' page with no server-rendered <title>/og:tags, invisible to
 * crawlers). Callers that only need metadata (generateMetadata) must wrap
 * this in their own try/catch and degrade gracefully — see blog page.tsx.
 */
export async function fetchPost(storeId: string, slug: string): Promise<BlogDetail | null> {
  if (!storeId || storeId === 'demo') return null;
  // NOTE: network errors intentionally propagate (no try/catch) — a transient
  // fetch failure must 500, not be swallowed into a false 404.
  // `/public/:storeId/blog/:slug` — the PUBLISHED-by-slug read. The previous
  // target, `/stores/:storeId/blog/:postId`, is the ADMIN single-post route
  // (authenticate + authorize + requireStoreAccess) and takes a post id, not a
  // slug. This fetch is server-side and sends no cookie, so it got a 401 —
  // neither 404 nor ok, so the throw below fired and the post page 500'd.
  // Confirmed against production 2026-09-13: the admin path 401s
  // unauthenticated while the public path returns a clean 404. No blog post
  // has ever existed in production (0 rows), so no reader met it.
  // `X-Store-ID` (LAUNCH-RL-MISS-3): the API's store-miss limiter leaves a dead blog link uncounted only when the
  // store was verified from this header and it equals the path id; without it every 404 here is a counted miss.
  const res = await fetch(`${API_URL}/public/${storeId}/blog/${encodeURIComponent(slug)}`, {
    headers: { 'X-Store-ID': storeId },
    next: { revalidate: 60 },
  });
  if (res.status === 404) return null; // definitive miss → caller resolves redirect / 404s
  if (!res.ok) throw new Error(`blog post fetch failed: ${res.status}`); // transient (5xx) → let it 500
  const json = await res.json();
  return (json?.data?.post ?? json?.data ?? null) as BlogDetail | null;
}

export function buildBlogPostMetadata(
  post: BlogDetail,
  store: ResolvedStore,
  slug: string
): Metadata {
  const description = post.excerpt ?? post.title;
  // og:image — the post cover when present, else the store-aware OG card so an
  // imageless post still gets the store's branded preview (not a blank card).
  const ogImages = post.coverImage
    ? [post.coverImage]
    : store.slug
      ? [
          {
            url: `/og?slug=${encodeURIComponent(store.slug)}`,
            width: 1200,
            height: 630,
            alt: store.name,
          },
        ]
      : [];
  // Platform-path stores need the `/<slug>` prefix (see storeAbsoluteUrl doc
  // comment) — a bare relative `/blog/${slug}` canonical resolves against
  // metadataBase, which for platform-path stores is the store-less origin.
  const canonicalUrl = storeAbsoluteUrl(store, `/blog/${slug}`);

  return {
    title: post.title,
    description,
    openGraph: {
      title: post.title,
      description: post.excerpt ?? '',
      images: ogImages,
      type: 'article',
      url: canonicalUrl,
    },
    alternates: { canonical: canonicalUrl },
  };
}

export async function BlogPostBody({ store, slug }: { store: ResolvedStore; slug: string }) {
  const post = await fetchPost(store.id, slug);

  // Genuine miss on a real store: try to resolve a renamed-slug 308 before
  // giving up (also fixes blog's soft-404 for real stores — see
  // ProductDetailBody's equivalent branch for the platform-prefix rationale).
  if (!post) {
    if (store.id !== 'demo') {
      const toSlug = await fetchSlugRedirect(store, 'blog', slug);
      if (toSlug && toSlug !== slug) {
        // encodeURIComponent — see ProductDetailBody: a raw Arabic handle in the
        // `Location` header throws `Invalid character in header content`.
        permanentRedirect(storeRedirectUrl(store, `/blog/${encodeURIComponent(toSlug)}`));
      }
      notFound();
    }
    // demo store: fall through to existing behavior (renders with post=null)
  }

  // Article JSON-LD rendered server-side for SEO / AI crawlers (F2). Built
  // from already-fetched data; JSON.stringify makes it injection-safe.
  const jsonLd = post
    ? {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.excerpt ?? post.title,
        ...(post.coverImage ? { image: post.coverImage } : {}),
        datePublished: post.publishedAt ?? post.createdAt,
        publisher: { '@type': 'Organization', name: store.name },
        mainEntityOfPage: { '@type': 'WebPage', '@id': storeAbsoluteUrl(store, `/blog/${slug}`) },
      }
    : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          // Serialized via jsonLdScriptContent, which escapes `<`/`>` so
          // merchant-authored blog titles/excerpts cannot break out of this
          // <script> block. Never switch this back to bare JSON.stringify.
          dangerouslySetInnerHTML={{
            __html: jsonLdScriptContent(
              localizeJsonLdUrls(
                jsonLd,
                getSiteUrl(store),
                (await localePathContext())?.locale ?? null
              )
            ),
          }}
        />
      )}
      <BlogPostClient
        post={post}
        shareUrl={post ? storeAbsoluteUrl(store, `/blog/${slug}`) : undefined}
      />
    </>
  );
}
