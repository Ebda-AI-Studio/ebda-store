import type { Metadata } from 'next';
import type { ResolvedStore } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import { BlogPostClient, type BlogDetail } from './BlogPostClient';

/**
 * Blog post body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both `app/blog/[slug]/page.tsx`
 * (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/blog/[slug]/page.tsx` (new, params-based,
 * dark-launched). See docs/plans/2026-07-12-tenant-cacheable-routing.md
 * §3.6/§9 — this is the one Track-A route the plan explicitly calls out as
 * needing the resolver swap (the blog index itself is a pure client shell).
 */

/**
 * Fetch a single blog post server-side. Returns null on any failure so the
 * page can render the not-found state. Used for both SSR metadata and the
 * Article JSON-LD (F2 — was previously a client-only 'use client' page with no
 * server-rendered <title>/og:tags, invisible to crawlers).
 */
export async function fetchPost(storeId: string, slug: string): Promise<BlogDetail | null> {
  if (!storeId || storeId === 'demo') return null;
  try {
    const res = await fetch(`${API_URL}/stores/${storeId}/blog/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data?.post ?? json?.data ?? null) as BlogDetail | null;
  } catch {
    return null;
  }
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
  return {
    title: post.title,
    description,
    openGraph: {
      title: post.title,
      description: post.excerpt ?? '',
      images: ogImages,
      type: 'article',
    },
    alternates: { canonical: `/blog/${slug}` },
  };
}

export async function BlogPostBody({ store, slug }: { store: ResolvedStore; slug: string }) {
  const post = await fetchPost(store.id, slug);

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
        mainEntityOfPage: { '@type': 'WebPage', '@id': `/blog/${slug}` },
      }
    : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- JSON.stringify output of
          // server-controlled fields only; no user HTML is injected here.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <BlogPostClient post={post} />
    </>
  );
}
