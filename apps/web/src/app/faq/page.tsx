import type { Metadata } from 'next';
import { getStore } from '../../lib/store-resolver';
import { FaqPageBody } from './FaqPageBody';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about ordering, shipping, returns, and more.',
};

export default async function FAQPage() {
  const store = await getStore();

  return <FaqPageBody store={store} />;
}
