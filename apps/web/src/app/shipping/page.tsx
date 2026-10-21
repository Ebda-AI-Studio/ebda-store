import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ShippingClient from './ShippingClient';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Shipping Policy', 'سياسة الشحن'],
    description: [
      'Learn about our shipping options, delivery times, and costs.',
      'تعرّف على خيارات الشحن ومدة التوصيل وتكلفته.',
    ],
  });
}

export default function ShippingPage() {
  return <ShippingClient />;
}
