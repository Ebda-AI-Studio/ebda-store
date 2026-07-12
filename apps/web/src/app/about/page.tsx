import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { AboutPageBody } from './AboutPageBody';

export const metadata: Metadata = {
  title: 'About Us',
  description: 'Learn more about our store',
};

export default async function AboutPage() {
  const store = await getStoreOrNotFound();

  return <AboutPageBody store={store} />;
}
