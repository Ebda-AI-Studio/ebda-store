import type { ResolvedStore } from '../../lib/store-resolver';
import {
  faqPageJsonLd,
  howToJsonLd,
  breadcrumbJsonLd,
  storeAbsoluteUrl,
} from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import FAQClient from './FAQClient';

/**
 * FAQ page body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both `app/faq/page.tsx` (legacy,
 * header-based) and `app/tenant-store/[tenant]/[locale]/faq/page.tsx` (new,
 * params-based, dark-launched). See
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
 */
export async function FaqPageBody({ store }: { store: ResolvedStore }) {
  // Build FAQ JSON-LD from store-authored FAQs (both locales included via
  // mainEntityOfPage on each Question; English used as the canonical form
  // here — Google will see AR equivalents via hreflang).
  const storeFaqs = store.faqs ?? [];
  const storeHowtos = store.howtos ?? [];

  // Cap at 50 FAQs in the JSON-LD to keep the payload reasonable (<20 KB).
  // Visible UI shows all; JSON-LD gets the top 50 ordered entries.
  const faqJsonLdItems = storeFaqs.slice(0, 50).map(f => ({
    question: f.question,
    answer: f.answer,
  }));

  const faqBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: storeAbsoluteUrl(store, '') },
    { name: 'FAQ', url: storeAbsoluteUrl(store, '/faq') },
  ]);

  return (
    <>
      <JsonLd data={faqBreadcrumb} />
      {faqJsonLdItems.length > 0 && <JsonLd data={faqPageJsonLd(faqJsonLdItems)} />}
      {storeHowtos.slice(0, 10).map(h => (
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
      <FAQClient storeFaqs={storeFaqs} storeHowtos={storeHowtos} />
    </>
  );
}
