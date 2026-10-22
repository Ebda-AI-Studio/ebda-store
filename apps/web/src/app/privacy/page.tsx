import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import PrivacyClient from './PrivacyClient';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Privacy Policy', 'سياسة الخصوصية'],
    description: [
      'Read our privacy policy to understand how we collect, use, and protect your data.',
      'اقرأ سياسة الخصوصية عشان تعرف إزاي بنجمع بياناتك وبنستخدمها وبنحميها.',
    ],
  });
}

export default function PrivacyPage() {
  return <PrivacyClient />;
}
