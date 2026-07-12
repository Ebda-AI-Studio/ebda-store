import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { ContactPageBody } from '@/app/contact/ContactPageBody';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with us. We are happy to help with any questions or feedback.',
};

export default async function StoreContactPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <ContactPageBody store={store} />;
}
