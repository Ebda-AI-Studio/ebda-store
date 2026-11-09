import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServiceLinePage } from '@/components/ServiceLinePage';
import { SERVICES_META, pageMetadata } from '@/lib/seo';
import { serviceLinesBuilt } from '@/lib/service-lines';

const p = SERVICES_META['ar']['design'];

export const metadata: Metadata = pageMetadata('ar', 'services/design', p.title, p.desc);

// SERVICES-IA-1: with the flag off (production default) there is nothing here: the build exports the site 404 for this path.
export default function Page() {
  if (!serviceLinesBuilt()) notFound();
  return <ServiceLinePage locale="ar" id="design" />;
}
