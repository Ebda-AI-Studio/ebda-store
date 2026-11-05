import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { storefrontAlternates } from '@/lib/seo/locale-alternates';
import { getStoreByTenantParam, isResolvedStore } from '@/lib/store-resolver';
import { BlogIndexBody } from '@/app/blog/BlogIndexBody';

// The blog index is server-rendered (audit 2026-11-03 #7): the store comes from the tenant param,
// like the post page beside it, so the route stays free of request-header Dynamic APIs.
interface StorePageProps {
  params: Promise<{ tenant: string }>;
}

export async function generateMetadata({ params }: StorePageProps): Promise<Metadata> {
  const store = await getStoreByTenantParam((await params).tenant);
  return localizedMetadata({
    title: ['Blog', 'المدونة'],
    description: ['Stories, guides and news from the store.', 'مقالات وأدلة وأخبار من المتجر.'],
    ...(isResolvedStore(store)
      ? { alternates: await storefrontAlternates(store, '/blog', true) }
      : {}),
  });
}

export default async function StoreBlogIndexPage({ params }: StorePageProps) {
  const store = await getStoreByTenantParam((await params).tenant);
  return <BlogIndexBody store={store} />;
}
