import Link from 'next/link';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { pageJsonLd } from '../lib/seo';
import { serviceLinesPublished } from '../lib/service-lines';
import { SERVICE_LINE_CONTENT } from '../lib/service-lines-content';
import { SERVICES_PAGE } from '../lib/services-page';
import { pagePath, type Locale } from '../lib/site';
import '@/app/services.css';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { ServicesGrid } from './ServicesGrid';

/**
 * The Services index (`/services`, `/en/services`; Ruling SERVICES-IA-1): FIRST the core (the BRAND.services categories, the same grid as
 * the studio home and About: AI, software, consulting and training), THEN the three service lines as cards linking to their pages.
 */
export function ServicesIndexPage({ locale }: { locale: Locale }) {
  const p = SERVICES_PAGE[locale];
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      {serviceLinesPublished() && (
        <JsonLd
          data={pageJsonLd(locale, 'services', p.meta.title, p.meta.desc, {
            type: 'CollectionPage',
          })}
        />
      )}
      <Header locale={locale} page="services" />
      <main id="main" className="ab sv-index">
        <header className="wrap ab-hero">
          <p className="ab-eyebrow">{p.eyebrow}</p>
          <h1>{p.h1}</h1>
          <p className="ab-lead">{p.lead}</p>
        </header>

        <section className="ab-sec ab-m8" aria-labelledby="svx-core-h" id="core">
          <div className="wrap">
            <h2 className="ab-h2" id="svx-core-h">
              {p.coreH}
            </h2>
            <p className="sv-statement">{p.coreLead}</p>
            <ServicesGrid locale={locale} />
          </div>
        </section>

        <section className="ab-sec ab-mr" aria-labelledby="svx-lines-h">
          <div className="wrap">
            <h2 className="ab-h2" id="svx-lines-h">
              {p.linesH}
            </h2>
            <p className="sv-statement">{p.linesLead}</p>
            <ul className="sv-cards">
              {BRAND.serviceLines.map(l => {
                const c = SERVICE_LINE_CONTENT[l.id][locale];
                const name = locale === 'ar' ? l.ar : l.en;
                return (
                  <li key={l.id} className={`sv-card sv-${l.id}`} data-service-line={l.id}>
                    <h3>
                      <Link href={`${pagePath(locale, `services/${l.id}`)}/`}>
                        {name}
                        <span className="sv-card-sr"> — {c.tagline}</span>
                      </Link>
                    </h3>
                    <p className="sv-card-tag">{c.tagline}</p>
                    <p>{c.what.statement}</p>
                    <span className="sv-card-cta" aria-hidden="true">
                      {p.cardCta}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </main>
      <Footer locale={locale} page="services" />
    </>
  );
}
