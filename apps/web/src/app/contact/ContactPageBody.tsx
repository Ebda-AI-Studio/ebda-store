import type { ResolvedStore } from '../../lib/store-resolver';
import { breadcrumbJsonLd, storeAbsoluteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import ContactClient from './ContactClient';

/**
 * Contact page body — extracted 2026-07-12 (tenant-cacheable routing,
 * Phase 1) so the SAME rendering logic serves both `app/contact/page.tsx`
 * (legacy, header-based) and `app/tenant-store/[tenant]/[locale]/contact/page.tsx`
 * (new, params-based, dark-launched). See
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
 */
export async function ContactPageBody({ store }: { store: ResolvedStore }) {
  const siteUrl = storeAbsoluteUrl(store, '');

  const contactBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'Contact', url: storeAbsoluteUrl(store, '/contact') },
  ]);

  // ContactPage schema — declares the page type and embeds a ContactPoint.
  const contactPageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: `Contact ${store.name}`,
    url: storeAbsoluteUrl(store, '/contact'),
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
              areaServed: 'EG',
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
