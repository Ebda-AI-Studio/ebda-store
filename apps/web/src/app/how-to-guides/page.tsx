import type { Metadata } from 'next';
import { getStore } from '../../lib/store-resolver';
import { howToJsonLd, breadcrumbJsonLd, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import HowToGuidesClient from './HowToGuidesClient';

export const metadata: Metadata = {
  title: 'How-To Guides',
  description:
    'Step-by-step guides for ordering, returns, payments, and product care. Quick answers in plain language.',
};

export default async function HowToGuidesPage() {
  const store = await getStore();
  const siteUrl = getSiteUrl(store);
  const storeHowtos = store.howtos ?? [];

  const breadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'How-To Guides', url: `${siteUrl}/how-to-guides` },
  ]);

  return (
    <>
      <JsonLd data={breadcrumb} />
      {storeHowtos.slice(0, 20).map(h => (
        <JsonLd
          key={h.id}
          data={howToJsonLd({
            name: h.title,
            description: h.description,
            steps: Array.isArray(h.steps)
              ? (h.steps as Array<{ name: string; text: string; image?: string }>)
              : [],
          })}
        />
      ))}
      <HowToGuidesClient storeHowtos={storeHowtos} />
    </>
  );
}
