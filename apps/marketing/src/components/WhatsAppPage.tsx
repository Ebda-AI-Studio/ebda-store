import { Fragment } from 'react';
import Link from 'next/link';
import {
  BRAND,
  WHATSAPP_MONTHLY_PACKAGES,
  whatsappYearlyOf,
  type WhatsAppBasePackageId,
  type WhatsAppPackageDef,
} from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { egp } from '../lib/demo-stores';
import { whatsappJsonLd } from '../lib/seo';
import { STORE_HOME, pagePath, type Locale } from '../lib/site';
import { WHATSAPP_APP_URL, WHATSAPP_PAGE, WHATSAPP_YEARLY_SAVING_PCT } from '../lib/whatsapp-page';
import { Footer } from './Footer';
import { Header } from './Header';
import { Reveal } from './Motion';
import { WaChatVisual } from './WaChatVisual';
import { JsonLd } from './JsonLd';
import { SiteLink } from './SiteLink';

const FEATURE_ORDER = [
  'shared_inbox',
  'order_confirmations',
  'templates',
  'campaigns',
  'order_in_chat',
  'api',
  'priority_support',
] as const;

/** The card's feature lines, from the package constant (never typed): seats, the switches that are on, AI replies. */
function packageLines(locale: Locale, pkg: WhatsAppPackageDef): string[] {
  const c = WHATSAPP_PAGE[locale].pricing;
  return [
    c.members(pkg.features.members),
    ...FEATURE_ORDER.filter(k => pkg.features[k]).map(k => c.features[k]),
    c.aiCredits(pkg.features.ai_credits),
  ];
}

/** Four package cards and a monthly/yearly switch (CSS only, like the Store plans); prices from WHATSAPP_PACKAGES. */
function Pricing({ locale }: { locale: Locale }) {
  const c = WHATSAPP_PAGE[locale].pricing;
  return (
    <section className="page-sec" aria-labelledby="wa-pricing-h" id="pricing">
      <h2 id="wa-pricing-h">{c.title}</h2>
      <p className="lead">{c.lead}</p>
      <Reveal className="plans-wrap wa-pricing">
        <fieldset className="plan-pick wa-interval">
          <legend>{c.intervalLabel}</legend>
          <input type="radio" name="wa-interval" id="wa-month" defaultChecked />
          <label htmlFor="wa-month">{c.monthly}</label>
          <input type="radio" name="wa-interval" id="wa-year" />
          <label htmlFor="wa-year">{c.yearly}</label>
        </fieldset>
        <fieldset className="plan-pick wa-pick">
          <legend>{c.pickLabel}</legend>
          {WHATSAPP_MONTHLY_PACKAGES.map(p => (
            <Fragment key={p.id}>
              <input
                type="radio"
                name="wa-plan-pick"
                id={`wa-pick-${p.id}`}
                defaultChecked={p.id === 'growth'}
              />
              <label htmlFor={`wa-pick-${p.id}`}>
                {c.names[p.id as WhatsAppBasePackageId].short}
              </label>
            </Fragment>
          ))}
        </fieldset>
        <ul className="plans wa-plans">
          {WHATSAPP_MONTHLY_PACKAGES.map(p => {
            const n = c.names[p.id as WhatsAppBasePackageId];
            const included = p.id === 'store-included';
            return (
              <li key={p.id} className="plan" data-plan={p.id}>
                <h3>{n.name}</h3>
                <p className="muted plan-tag">{n.tag}</p>
                {included ? (
                  <p className="price price-text">{c.includedLabel}</p>
                ) : (
                  <p className="price">
                    <span className="wa-m">{egp(locale, p.priceMinor / 100)}</span>
                    <span className="wa-y">
                      {egp(
                        locale,
                        whatsappYearlyOf(p.id as WhatsAppBasePackageId).priceMinor / 100
                      )}
                    </span>
                    <span className="per wa-m"> {c.perMonth}</span>
                    <span className="per wa-y"> {c.perYear}</span>
                  </p>
                )}
                <ul className="plan-features">
                  {packageLines(locale, p).map(f => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {included ? (
                  <Link
                    href={`${STORE_HOME[locale]}#pricing`}
                    className="btn btn-ghost"
                    data-plan-cta={p.id}
                  >
                    {c.ctaIncluded}
                  </Link>
                ) : (
                  <SiteLink
                    href={WHATSAPP_APP_URL}
                    locale={locale}
                    className={`btn ${p.id === 'growth' ? 'btn-primary' : 'btn-ghost'}`}
                    data-plan-cta={p.id}
                  >
                    {c.cta.replace('{plan}', n.name)}
                  </SiteLink>
                )}
              </li>
            );
          })}
        </ul>
      </Reveal>
      <p className="muted small">{c.saveNote(WHATSAPP_YEARLY_SAVING_PCT)}</p>
      <p className="muted small wa-meta-note">{c.metaNote}</p>
    </section>
  );
}

/** The Ebda Chat product page: /whatsapp (Arabic, default) and /en/whatsapp. Facts: lib/whatsapp-page.ts. */
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
        <header className="page-head wa-head">
          <div className="wa-head-copy">
            <h1>{p.h1}</h1>
            <p className="lead">{p.lead}</p>
            <p className="actions">
              <SiteLink href={WHATSAPP_APP_URL} locale={locale} className="btn btn-primary btn-lg">
                {p.ctaStart}
              </SiteLink>
            </p>
          </div>
          <WaChatVisual locale={locale} />
        </header>

        <section className="page-sec" aria-labelledby="wa-feats-h" id="features">
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

        <Pricing locale={locale} />

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

        <section className="page-sec" aria-labelledby="wa-faq-h" id="faq">
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
            <SiteLink href={WHATSAPP_APP_URL} locale={locale} className="btn btn-primary btn-lg">
              {p.ctaStart}
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
      <Footer locale={locale} page="whatsapp" />
    </>
  );
}

/** A short block that points to the Ebda Chat page (home, below the capability line; /features, above the comparisons). */
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
