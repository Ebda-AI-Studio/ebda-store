import type { Metadata } from 'next';
import TermsClient from './TermsClient';

export const metadata: Metadata = {
  title: 'Terms & Conditions',
};

export default function TermsPage() {
  return <TermsClient />;
}
