import type { Metadata } from 'next';
import FAQClient from './FAQClient';

export const metadata: Metadata = {
  title: 'FAQ',
};

export default function FAQPage() {
  return <FAQClient />;
}
