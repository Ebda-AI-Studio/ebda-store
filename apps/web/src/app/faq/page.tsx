import type { Metadata } from 'next';
import FAQClient from './FAQClient';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about ordering, shipping, returns, and more.',
};

export default function FAQPage() {
  return <FAQClient />;
}
