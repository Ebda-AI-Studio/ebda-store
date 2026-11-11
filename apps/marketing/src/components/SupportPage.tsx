import { PageLink } from './PageLink';
import { COPY } from '../lib/content';
import { SUPPORT_PAGE } from '../lib/support-page';
import { pageJsonLd } from '../lib/seo';
import { HOME, pagePath, type Locale } from '../lib/site';
import { BRAND } from '@ebda/shared/brand';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';

/** /support (audit M-033): hours, how a message is handled, and when it goes to a person. */
export function SupportPage({ locale }: { locale: Locale }) {
  const p = SUPPORT_PAGE[locale];
  return (
    <>
      <JsonLd data={pageJsonLd(locale, 'support', p.title, p.desc)} />
      <Header locale={locale} page="support" />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{p.title}</h1>
          <p className="legal-notice">{p.intro}</p>
        </header>
        <article className="legal-doc">
          <section aria-labelledby="support-hours-h">
            <h2 id="support-hours-h">{p.hoursH}</h2>
            <p>{p.hoursP}</p>
          </section>
          <section aria-labelledby="support-flow-h">
            <h2 id="support-flow-h">{p.flowH}</h2>
            <ol>
              {p.flow.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </section>
          <section aria-labelledby="support-esc-h">
            <h2 id="support-esc-h">{p.escalateH}</h2>
            <p>{p.escalateLead}</p>
            <ul>
              {p.escalate.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="support-reach-h">
            <h2 id="support-reach-h">{p.reachH}</h2>
            <p>{p.reachP}</p>
            <p>
              <a href={`mailto:${BRAND.supportEmail}`} dir="ltr">
                {BRAND.supportEmail}
              </a>
              {' · '}
              <PageLink href={pagePath(locale, 'contact')}>{p.reachCta}</PageLink>
            </p>
          </section>
          <p className="legal-back">
            <PageLink href={HOME[locale]}>{COPY[locale].legalPages.back}</PageLink>
          </p>
        </article>
      </main>
      <Footer locale={locale} />
    </>
  );
}
