import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { breadcrumbJsonLd, storeJsonLd, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import AboutClient from './AboutClient';

export const metadata: Metadata = {
  title: 'About Us',
  description: 'Learn more about our store',
};

export default async function AboutPage() {
  const store = await getStoreOrNotFound();
  const siteUrl = getSiteUrl(store);

  const aboutBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'About', url: `${siteUrl}/about` },
  ]);

  // AboutPage schema — declares the page type and references the store entity.
  const aboutPageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: `About ${store.name}`,
    url: `${siteUrl}/about`,
    mainEntity: storeJsonLd({
      name: store.name,
      url: siteUrl,
      logo: store.logo,
      email: store.email,
      phone: store.phone,
      address: store.address,
      description: store.description,
    }),
  };

  return (
    <>
      {/* JSON-LD: Breadcrumb + AboutPage */}
      <JsonLd data={aboutBreadcrumb} />
      <JsonLd data={aboutPageJsonLd} />
      <AboutClient />
    </>
  );
}
