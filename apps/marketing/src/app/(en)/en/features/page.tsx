import type { Metadata } from 'next';
import { FeaturesPage } from '@/components/FeaturesPage';
import { FEATURES_PAGE } from '@/lib/capabilities';
import { pageMetadata } from '@/lib/seo';

const p = FEATURES_PAGE['en'];

export const metadata: Metadata = pageMetadata('en', 'features', p.title, p.desc);

export default function Page() {
  return <FeaturesPage locale="en" />;
}
