import Link from 'next/link';
import { CAPABILITY_IDS, FEATURES_FAQ, FEATURES_PAGE, MORE } from '../lib/capabilities';
import { COPY } from '../lib/content';
import { COMPARE } from '../lib/compare';
import { jsonLd } from '../lib/seo';
import { COMPARE_PAGES, SIGNUP_URL, pagePath, type Locale } from '../lib/site';
import { CapabilityGrid } from './Capabilities';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';

export function FeaturesPage({ locale }: { locale: Locale }) {
  const p = FEATURES_PAGE[locale];
  const more = MORE[locale];
  const faq = FEATURES_FAQ[locale];
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={jsonLd(locale, faq)} />
      <Header locale={locale} page="features" />
      <main id="main" className="wrap page">
        <header className="page-head">
          <h1>{p.h1}</h1>
          <p className="lead">{p.lead}</p>
          <p className="actions">
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
              {p.cta}
            </a>
          </p>
        </header>
        <section aria-label={p.title}>
          <CapabilityGrid locale={locale} ids={CAPABILITY_IDS} />
        </section>
        <section className="page-sec" aria-labelledby="more-h">
          <h2 id="more-h">{more.title}</h2>
          <ul className="more-list">
            {more.items.map(i => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
        <section className="page-sec" aria-labelledby="faq-h">
          <h2 id="faq-h">{p.faqTitle}</h2>
          <div className="faq">
            {faq.map(i => (
              <details key={i.q}>
                <summary>{i.q}</summary>
                <p>{i.a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="page-sec" aria-labelledby="cmp-h">
          <h2 id="cmp-h">{p.compareTitle}</h2>
          <ul className="cmp-links">
            {COMPARE_PAGES.map(page => {
              const slug = page.split('/')[1] as keyof typeof COMPARE;
              return (
                <li key={page}>
                  <Link href={pagePath(locale, page)}>{COMPARE[slug][locale].linkText}</Link>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
      <Footer locale={locale} />
    </>
  );
}
