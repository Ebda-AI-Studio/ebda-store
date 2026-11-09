import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServicesIndexPage } from '@/components/ServicesIndexPage';
import { pageMetadata } from '@/lib/seo';
import { serviceLinesBuilt } from '@/lib/service-lines';
import { SERVICES_PAGE } from '@/lib/services-page';

const p = SERVICES_PAGE['en'];

export const metadata: Metadata = pageMetadata('en', 'services', p.meta.title, p.meta.desc);

// SERVICES-IA-1: with the flag off (production default) there is nothing here: the build exports the site 404 for this path.
export default function Page() {
  if (!serviceLinesBuilt()) notFound();
  return <ServicesIndexPage locale="en" />;
}
