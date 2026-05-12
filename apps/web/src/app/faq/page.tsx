import type { Metadata } from 'next';
import { getStore } from '../../lib/store-resolver';
import {
  faqPageJsonLd,
  howToJsonLd,
  breadcrumbJsonLd,
  getSiteUrl,
} from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import FAQClient from './FAQClient';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about ordering, shipping, returns, and more.',
};

export default async function FAQPage() {
  const store = await getStore();
  const siteUrl = getSiteUrl(store);

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
    { name: 'Home', url: siteUrl },
    { name: 'FAQ', url: `${siteUrl}/faq` },
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
