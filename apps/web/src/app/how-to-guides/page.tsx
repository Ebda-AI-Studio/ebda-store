import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { HowToGuidesPageBody } from './HowToGuidesPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['How-To Guides', 'أدلة الاستخدام'],
    description: [
      'Step-by-step guides for ordering, returns, payments, and product care. Quick answers in plain language.',
      'أدلة خطوة بخطوة للطلب والإرجاع والدفع والعناية بالمنتجات، بإجابات سريعة وواضحة.',
    ],
  });
}

export default async function HowToGuidesPage() {
  const store = await getStoreOrNotFound();

  return <HowToGuidesPageBody store={store} />;
}
