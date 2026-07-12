import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { HowToGuidesPageBody } from '@/app/how-to-guides/HowToGuidesPageBody';

export const metadata: Metadata = {
  title: 'How-To Guides',
  description:
    'Step-by-step guides for ordering, returns, payments, and product care. Quick answers in plain language.',
};

export default async function StoreHowToGuidesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <HowToGuidesPageBody store={store} />;
}
