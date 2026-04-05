import type { Metadata } from 'next';
import TermsClient from './TermsClient';

export const metadata: Metadata = {
  title: 'Terms & Conditions',
  description: 'Terms and conditions for using our online store and services.',
};

export default function TermsPage() {
  return <TermsClient />;
}
