import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import TermsClient from './TermsClient';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Terms & Conditions', 'الشروط والأحكام'],
    description: [
      'Terms and conditions for using our online store and services.',
      'الشروط والأحكام لاستخدام متجرنا وخدماتنا.',
    ],
  });
}

export default function TermsPage() {
  return <TermsClient />;
}
