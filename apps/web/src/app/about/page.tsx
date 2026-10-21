import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { AboutPageBody } from './AboutPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['About Us', 'من نحن'],
    description: ['Learn more about our store', 'تعرّف على متجرنا'],
  });
}

export default async function AboutPage() {
  const store = await getStoreOrNotFound();

  return <AboutPageBody store={store} />;
}
