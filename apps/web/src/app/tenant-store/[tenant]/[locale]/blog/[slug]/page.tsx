import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { BlogPostBody, buildBlogPostMetadata, fetchPost } from '@/app/blog/[slug]/BlogPostBody';

interface StorePageProps {
  params: Promise<{ tenant: string; slug: string }>;
}

export async function generateMetadata({ params }: StorePageProps): Promise<Metadata> {
  const { tenant, slug } = await params;
  const store = await getStoreByTenantParam(tenant);
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

export default async function StoreBlogPostPage({ params }: StorePageProps) {
  const { tenant, slug } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <BlogPostBody store={store} slug={slug} />;
}
