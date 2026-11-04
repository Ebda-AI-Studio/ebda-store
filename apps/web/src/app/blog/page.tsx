import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { storefrontAlternates } from '@/lib/seo/locale-alternates';
import { getStore, getStoreOrNotFound, isResolvedStore } from '../../lib/store-resolver';
import { BlogIndexBody } from './BlogIndexBody';

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  return localizedMetadata({
    title: ['Blog', 'المدونة'],
    description: ['Stories, guides and news from the store.', 'مقالات وأدلة وأخبار من المتجر.'],
    ...(isResolvedStore(store)
      ? { alternates: await storefrontAlternates(store, '/blog', true) }
      : {}),
  });
}

export default async function BlogIndexPage() {
  const store = await getStoreOrNotFound();
  return <BlogIndexBody store={store} />;
}
