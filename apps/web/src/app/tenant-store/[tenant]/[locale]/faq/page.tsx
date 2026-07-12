import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { FaqPageBody } from '@/app/faq/FaqPageBody';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about ordering, shipping, returns, and more.',
};

export default async function StoreFaqPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <FaqPageBody store={store} />;
}
