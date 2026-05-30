import type { Metadata } from 'next';
import { getStore } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import { BlogPostClient, type BlogDetail } from './BlogPostClient';

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * Fetch a single blog post server-side. Returns null on any failure so the
 * page can render the not-found state. Used for both SSR metadata and the
 * Article JSON-LD (F2 — was previously a client-only 'use client' page with no
 * server-rendered <title>/og:tags, invisible to crawlers).
 */
async function fetchPost(storeId: string, slug: string): Promise<BlogDetail | null> {
  if (!storeId || storeId === 'demo') return null;
  try {
    const res = await fetch(
      `${API_URL}/stores/${storeId}/blog/${encodeURIComponent(slug)}`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data?.post ?? json?.data ?? null) as BlogDetail | null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStore();
  const post = await fetchPost(store.id, slug);
  if (!post) return { title: 'Not found' };
  const description = post.excerpt ?? post.title;
  return {
    title: post.title,
    description,
    openGraph: {
      title: post.title,
      description: post.excerpt ?? '',
      images: post.coverImage ? [post.coverImage] : [],
      type: 'article',
    },
    alternates: { canonical: `/blog/${slug}` },
  };
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const store = await getStore();
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
