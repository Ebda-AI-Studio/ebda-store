import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { withLocaleAlternates } from '@/lib/seo/locale-alternates';
import { getStore, getStoreOrNotFound } from '../../../lib/store-resolver';
import { decodeRouteParam } from '../../../lib/route-params';
import { storeAbsoluteUrl } from '../../../lib/structured-data';
import { fetchCustomPage, metaDescriptionFrom } from '../../../lib/custom-page';
import { CustomPageView } from './CustomPageView';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const slug = decodeRouteParam((await params).slug);
  const store = await getStore();
  try {
    const page = await fetchCustomPage(store.id, slug);
    if (!page) return { title: 'Not found' };
    const title = page.title || page.titleAr || slug;
    const description = metaDescriptionFrom(page.contentHtml || page.contentHtmlAr || '');
    const canonical = storeAbsoluteUrl(store, `/pages/${encodeURIComponent(slug)}`);
    return withLocaleAlternates(
      {
        title,
        ...(description ? { description } : {}),
        alternates: { canonical },
        openGraph: {
          title,
          ...(description ? { description } : {}),
          url: canonical,
          type: 'website',
        },
      },
      store,
      `/pages/${slug}`
    );
  } catch {
    return { title: 'Page' };
  }
}

export default async function CustomPage({ params }: PageProps) {
  const slug = decodeRouteParam((await params).slug);
  const store = await getStoreOrNotFound();
  const page = await fetchCustomPage(store.id, slug);
  if (!page) notFound();
  return <CustomPageView page={page} />;
}
