import type { ResolvedStore } from '../../lib/store-resolver';
import { howToJsonLd, breadcrumbJsonLd, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import HowToGuidesClient from './HowToGuidesClient';

/**
 * How-To Guides page body — extracted 2026-07-12 (tenant-cacheable
 * routing, Phase 1) so the SAME rendering logic serves both
 * `app/how-to-guides/page.tsx` (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/how-to-guides/page.tsx` (new,
 * params-based, dark-launched). See
 * docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
 */
export async function HowToGuidesPageBody({ store }: { store: ResolvedStore }) {
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
