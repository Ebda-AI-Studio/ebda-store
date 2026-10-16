import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { BundlesPageBody } from './BundlesPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Bundles', 'العروض المجمعة'],
    description: [
      'Shop curated product bundles at a special price. Fast delivery in Egypt.',
      'تسوّق مجموعات منتجات مختارة بسعر خاص، مع توصيل سريع في مصر.',
    ],
  });
}

export default async function BundlesPage() {
  const store = await getStoreOrNotFound();
  return <BundlesPageBody store={store} />;
}
