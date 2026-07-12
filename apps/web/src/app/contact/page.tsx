import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { ContactPageBody } from './ContactPageBody';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with us. We are happy to help with any questions or feedback.',
};

export default async function ContactPage() {
  const store = await getStoreOrNotFound();

  return <ContactPageBody store={store} />;
}
