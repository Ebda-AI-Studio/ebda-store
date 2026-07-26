import type { Metadata } from 'next';
import { getStore } from '../../../lib/store-resolver';
import { BlogPostBody, buildBlogPostMetadata, fetchPost } from './BlogPostBody';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
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
  const { slug } = await params;
  const store = await getStore();

  return <BlogPostBody store={store} slug={slug} />;
}
