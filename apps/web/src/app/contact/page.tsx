import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { ContactPageBody } from './ContactPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Contact', 'تواصل معنا'],
    description: [
      'Get in touch with us. We are happy to help with any questions or feedback.',
      'تواصل معنا، يسعدنا الرد على أي سؤال أو ملاحظة.',
    ],
  });
}

export default async function ContactPage() {
  const store = await getStoreOrNotFound();

  return <ContactPageBody store={store} />;
}
