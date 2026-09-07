import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { BundlesPageBody } from './BundlesPageBody';

export const metadata: Metadata = {
  title: 'Bundles',
  description: 'Shop curated product bundles at a special price. Fast delivery in Kuwait.',
};

export default async function BundlesPage() {
  const store = await getStoreOrNotFound();
  return <BundlesPageBody store={store} />;
}
