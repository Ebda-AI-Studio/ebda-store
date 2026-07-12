import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { AboutPageBody } from '@/app/about/AboutPageBody';

export const metadata: Metadata = {
  title: 'About Us',
  description: 'Learn more about our store',
};

export default async function StoreAboutPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <AboutPageBody store={store} />;
}
