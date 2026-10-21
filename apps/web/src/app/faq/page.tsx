import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { FaqPageBody } from './FaqPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['FAQ', 'الأسئلة الشائعة'],
    description: [
      'Frequently asked questions about ordering, shipping, returns, and more.',
      'إجابات الأسئلة الشائعة عن الطلب والشحن والإرجاع وغيرها.',
    ],
  });
}

export default async function FAQPage() {
  const store = await getStoreOrNotFound();

  return <FaqPageBody store={store} />;
}
