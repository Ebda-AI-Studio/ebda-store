import type { Metadata } from 'next';
import { getStore } from '../../lib/store-resolver';
import { HowToGuidesPageBody } from './HowToGuidesPageBody';

export const metadata: Metadata = {
  title: 'How-To Guides',
  description:
    'Step-by-step guides for ordering, returns, payments, and product care. Quick answers in plain language.',
};

export default async function HowToGuidesPage() {
  const store = await getStore();

  return <HowToGuidesPageBody store={store} />;
}
