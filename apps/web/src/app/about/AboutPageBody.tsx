import type { ResolvedStore } from '../../lib/store-resolver';
import { breadcrumbJsonLd, storeJsonLd, storeAbsoluteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import AboutClient from './AboutClient';

/**
 * About page body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both `app/about/page.tsx` (legacy,
 * header-based) and `app/tenant-store/[tenant]/[locale]/about/page.tsx` (new,
 * params-based, dark-launched). See
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
 */
export async function AboutPageBody({ store }: { store: ResolvedStore }) {
  const siteUrl = storeAbsoluteUrl(store, '');

  const aboutBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'About', url: storeAbsoluteUrl(store, '/about') },
  ]);

  // AboutPage schema — declares the page type and references the store entity.
  const aboutPageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: `About ${store.name}`,
    url: storeAbsoluteUrl(store, '/about'),
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
