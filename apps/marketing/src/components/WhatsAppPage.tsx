import Link from 'next/link';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { whatsappJsonLd } from '../lib/seo';
import { SIGNUP_URL, pagePath, type Locale } from '../lib/site';
import { WHATSAPP_APP_URL, WHATSAPP_PAGE } from '../lib/whatsapp-page';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { SiteLink } from './SiteLink';

/** The Ebda WhatsApp product page: /whatsapp (Arabic, default) and /en/whatsapp. Facts: lib/whatsapp-page.ts. */
export function WhatsAppPage({ locale }: { locale: Locale }) {
  const p = WHATSAPP_PAGE[locale];
  const help = `https://${BRAND.domains.help}/${locale === 'ar' ? '' : 'en/'}`;
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={whatsappJsonLd(locale, p.faq)} />
      <Header locale={locale} page="whatsapp" />
      <main id="main" className="wrap page">
        <header className="page-head">
          <h1>{p.h1}</h1>
          <p className="lead">{p.lead}</p>
          <p className="actions">
            <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
              {p.ctaStart}
            </SiteLink>
            <SiteLink href={WHATSAPP_APP_URL} locale={locale} className="btn btn-ghost btn-lg">
              {p.ctaApp}
            </SiteLink>
          </p>
        </header>

        <section className="page-sec" aria-labelledby="wa-feats-h">
          <h2 id="wa-feats-h">{p.featuresH}</h2>
          <ul className="wa-feats">
            {p.features.map(f => (
              <li key={f.t}>
                <h3>{f.t}</h3>
                <p>{f.p}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="page-sec" aria-labelledby="wa-store-h">
          <h2 id="wa-store-h">{p.storeH}</h2>
          <p className="lead">{p.storeLead}</p>
          <ul className="more-list">
            {p.storePoints.map(t => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>

        <section className="page-sec" aria-labelledby="wa-numbers-h">
          <h2 id="wa-numbers-h">{p.numbersH}</h2>
          <p className="lead">{p.numbersLead}</p>
          <div className="cmp-wrap">
            <table className="cmp">
              <caption>{p.numbersH}</caption>
              <thead>
                <tr>
                  {p.table.cols.map(c => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.table.rows.map(r => (
                  <tr key={r[0]}>
                    <th scope="row">{r[0]}</th>
                    <td data-label={p.table.cols[1]}>{r[1]}</td>
                    <td data-label={p.table.cols[2]}>{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="page-sec" aria-labelledby="wa-fees-h">
          <h2 id="wa-fees-h">{p.feesH}</h2>
          {p.fees.map(t => (
            <p key={t} className="wa-prose">
              {t}
            </p>
          ))}
        </section>

        <section className="page-sec" aria-labelledby="wa-account-h">
          <h2 id="wa-account-h">{p.accountH}</h2>
          <p className="wa-prose">{p.account}</p>
        </section>

        <section className="page-sec" aria-labelledby="wa-faq-h">
          <h2 id="wa-faq-h">{p.faqH}</h2>
          <div className="faq">
            {p.faq.map(i => (
              <details key={i.q}>
                <summary>{i.q}</summary>
                <p>{i.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="page-sec wa-close" aria-labelledby="wa-close-h">
          <h2 id="wa-close-h">{p.closeH}</h2>
          <p className="wa-prose">{p.closeP}</p>
          <p className="actions">
            <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
              {p.ctaStart}
            </SiteLink>
            <SiteLink href={WHATSAPP_APP_URL} locale={locale} className="btn btn-ghost btn-lg">
              {p.ctaApp}
            </SiteLink>
          </p>
          <p className="muted small">
            <SiteLink href={help} locale={locale}>
              {p.helpLink}
            </SiteLink>
            {' · '}
            <Link href={pagePath(locale, 'features')}>{COPY[locale].nav.features}</Link>
          </p>
        </section>
      </main>
      <Footer locale={locale} />
    </>
  );
}

/** A short block that points to the Ebda WhatsApp page (home, below the capability line; /features, above the comparisons). */
export function WhatsAppTeaser({ locale }: { locale: Locale }) {
  const t = WHATSAPP_PAGE[locale].teaser;
  return (
    <div className="wa-teaser">
      <h3>{t.h}</h3>
      <p>{t.p}</p>
      <p className="actions">
        <Link href={pagePath(locale, 'whatsapp')} className="btn btn-ghost">
          {t.cta}
        </Link>
      </p>
    </div>
  );
}
