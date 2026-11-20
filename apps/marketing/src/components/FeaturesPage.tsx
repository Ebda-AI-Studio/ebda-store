import { SiteLink } from './SiteLink';
import { PageLink } from './PageLink';
import { featuresFaq, FEATURES_PAGE, MORE, THEMES, THEME_COPY } from '../lib/capabilities';
import { COPY } from '../lib/content';
import { COMPARE } from '../lib/compare';
import { jsonLd } from '../lib/seo';
import { COMPARE_PAGES, SIGNUP_URL, pagePath, type Locale } from '../lib/site';
import { CapabilityGrid, withHost } from './Capabilities';
import { Footer } from './Footer';
import { Header } from './Header';
import { WhatsAppTeaser } from './WhatsAppPage';
import { WHATSAPP_PAGE } from '../lib/whatsapp-page';
import { JsonLd } from './JsonLd';
import '@/app/route-store-wa.css';

export function FeaturesPage({ locale }: { locale: Locale }) {
  const p = FEATURES_PAGE[locale];
  const more = MORE[locale];
  const faq = featuresFaq(locale);
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
            <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
              {p.cta}
            </SiteLink>
          </p>
        </header>
        {THEMES.map(theme => (
          <section
            key={theme.id}
            className="page-sec"
            data-theme={theme.id}
            aria-labelledby={`theme-${theme.id}-h`}
          >
            <h2 id={`theme-${theme.id}-h`}>{THEME_COPY[locale][theme.id].title}</h2>
            <p className="lead">{THEME_COPY[locale][theme.id].lead}</p>
            <CapabilityGrid locale={locale} ids={theme.ids} />
          </section>
        ))}
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
                <p>{withHost(i.a)}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="page-sec" aria-label={WHATSAPP_PAGE[locale].teaser.h}>
          <WhatsAppTeaser locale={locale} />
        </section>
        <section className="page-sec" aria-labelledby="cmp-h">
          <h2 id="cmp-h">{p.compareTitle}</h2>
          <ul className="cmp-links">
            {COMPARE_PAGES.map(page => {
              const slug = page.split('/')[1] as keyof typeof COMPARE;
              return (
                <li key={page}>
                  <PageLink href={pagePath(locale, page)}>
                    {COMPARE[slug][locale].linkText}
                  </PageLink>
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
