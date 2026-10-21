import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ReturnsClient from './ReturnsClient';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Returns Policy', 'سياسة الإرجاع'],
    description: [
      'Our return and exchange policy. Learn how to return or exchange products.',
      'سياسة الإرجاع والاستبدال وكيفية إرجاع المنتجات أو استبدالها.',
    ],
  });
}

export default function ReturnsPage() {
  return <ReturnsClient />;
}
