import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { breadcrumbJsonLd, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import ContactClient from './ContactClient';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with us. We are happy to help with any questions or feedback.',
};

export default async function ContactPage() {
  const store = await getStoreOrNotFound();
  const siteUrl = getSiteUrl(store);

  const contactBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'Contact', url: `${siteUrl}/contact` },
  ]);

  // ContactPage schema — declares the page type and embeds a ContactPoint.
  const contactPageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: `Contact ${store.name}`,
    url: `${siteUrl}/contact`,
    mainEntity: {
      '@type': 'Organization',
      name: store.name,
      url: siteUrl,
      ...(store.email || store.phone
        ? {
            contactPoint: {
              '@type': 'ContactPoint',
              ...(store.phone ? { telephone: store.phone } : {}),
              ...(store.email ? { email: store.email } : {}),
              contactType: 'Customer Service',
              areaServed: 'KW',
              availableLanguage: ['Arabic', 'English'],
            },
          }
        : {}),
    },
  };

  return (
    <>
      {/* JSON-LD: Breadcrumb + ContactPage */}
      <JsonLd data={contactBreadcrumb} />
      <JsonLd data={contactPageJsonLd} />
      <ContactClient />
    </>
  );
}
