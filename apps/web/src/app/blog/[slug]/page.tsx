import type { Metadata } from 'next';
import { BlogPostClient } from './BlogPostClient';
import { getStoreServer } from '@/lib/store-server';

interface PageProps {
  params: Promise<{ slug: string }>;
}

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  content: string;
  coverImage?: string;
  publishedAt?: string;
  createdAt?: string;
  author?: string;
  tags?: string[];
}

async function fetchPost(storeId: string, slug: string): Promise<BlogPost | null> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/v1/stores/${storeId}/blog/${slug}`,
    { next: { revalidate: 60 } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.data ?? data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStoreServer();
  if (!store) return { title: 'Not found' };
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
  const store = await getStoreServer();
  const post = store ? await fetchPost(store.id, slug) : null;

  // Article JSON-LD rendered server-side for SEO / AI crawlers (F2).
  const jsonLd = post
    ? {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.excerpt ?? post.title,
        ...(post.coverImage ? { image: post.coverImage } : {}),
        ...(post.publishedAt || post.createdAt
          ? { datePublished: post.publishedAt ?? post.createdAt }
          : {}),
        ...(post.author ? { author: { '@type': 'Person', name: post.author } } : {}),
        ...(store ? { publisher: { '@type': 'Organization', name: store.name } } : {}),
        mainEntityOfPage: { '@type': 'WebPage', '@id': `/blog/${slug}` },
      }
    : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <BlogPostClient post={post} />
    </>
  );
}
