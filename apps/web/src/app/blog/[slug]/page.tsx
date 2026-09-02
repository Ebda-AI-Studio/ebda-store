import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound } from '../../../lib/store-resolver';
import { decodeRouteParam } from '../../../lib/route-params';
import { BlogPostBody, buildBlogPostMetadata, fetchPost } from './BlogPostBody';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  // `decodeRouteParam` — Next hands the page component the RAW segment while
  // generateMetadata gets the decoded one; see lib/route-params.ts.
  const slug = decodeRouteParam((await params).slug);
  const store = await getStore();
  // fetchPost can now throw on a transient (5xx/network) error — metadata
  // generation must degrade gracefully rather than 500 the whole page.
  try {
    const post = await fetchPost(store.id, slug);
    if (!post) return { title: 'Not found' };
    return buildBlogPostMetadata(post, store, slug);
  } catch {
    return { title: 'Blog' };
  }
}

export default async function BlogPostPage({ params }: PageProps) {
  const slug = decodeRouteParam((await params).slug);
  // Strict here (the page must 404 on an unresolvable host rather than render
  // the Force demo stub); generateMetadata above deliberately keeps the lenient
  // resolver so it degrades to a title instead of throwing notFound().
  const store = await getStoreOrNotFound();

  return <BlogPostBody store={store} slug={slug} />;
}
