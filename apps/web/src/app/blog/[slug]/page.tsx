import type { Metadata } from 'next';
import { getStore } from '../../../lib/store-resolver';
import { BlogPostBody, buildBlogPostMetadata, fetchPost } from './BlogPostBody';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStore();
  const post = await fetchPost(store.id, slug);
  if (!post) return { title: 'Not found' };
  return buildBlogPostMetadata(post, store, slug);
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const store = await getStore();

  return <BlogPostBody store={store} slug={slug} />;
}
