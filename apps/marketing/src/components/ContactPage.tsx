import { PageLink } from './PageLink';
import { BRAND, whatsappDisplay, whatsappUrl } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { pageJsonLd } from '../lib/seo';
import { HOME, SECURITY_EMAIL, type Locale } from '../lib/site';
import { serviceLinesBuilt } from '../lib/service-lines';
import { ContactForm } from './ContactForm';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { OfficeBlock } from './OfficeBlock';
import { SiteLink } from './SiteLink';

export function ContactPage({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const p = c.contactPage;
  const en = locale === 'en';
  return (
    <>
      <JsonLd data={pageJsonLd(locale, 'contact', p.title, p.desc, { type: 'ContactPage' })} />
      <Header locale={locale} page="contact" />
      <main id="main" className="ab">
        <header className="wrap ab-hero">
          <h1>{p.title}</h1>
          <p className="ab-lead">{p.lead}</p>
        </header>
        <section className="ab-sec ab-m8" aria-labelledby="contact-form-h">
          <div className="wrap cf-wrap">
            <h2 className="ab-h2" id="contact-form-h">
              {p.form.h}
            </h2>
            <p className="cf-lead">{p.form.lead}</p>
            <ContactForm locale={locale} lineTopics={serviceLinesBuilt()} />
          </div>
        </section>
        <section className="ab-sec ab-mr" aria-labelledby="contact-other-h">
          <div className="wrap legal">
            <h2 className="ab-h2" id="contact-other-h">
              {p.otherH}
            </h2>
            <article className="legal-doc">
              <section aria-labelledby="contact-email-h">
                <h2 id="contact-email-h">{p.emailH}</h2>
                <p>{p.emailP}</p>
                <p>
                  <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
                </p>
              </section>
              <section aria-labelledby="contact-wa-h">
                <h2 id="contact-wa-h">{p.whatsappH}</h2>
                <p>{p.whatsappP}</p>
                <p>
                  <SiteLink href={whatsappUrl()} locale={locale}>
                    <bdi dir="ltr">{whatsappDisplay()}</bdi>
                  </SiteLink>
                </p>
              </section>
              <section aria-labelledby="contact-help-h">
                <h2 id="contact-help-h">{p.helpH}</h2>
                <p>{p.helpP}</p>
                <p>
                  <SiteLink
                    href={`https://${BRAND.domains.help}${en ? '/en/' : '/'}`}
                    locale={locale}
                  >
                    {p.helpLink}
                  </SiteLink>
                  {' · '}
                  <SiteLink
                    href={`https://${BRAND.domains.status}${en ? '/en' : ''}`}
                    locale={locale}
                  >
                    {p.statusLink}
                  </SiteLink>
                </p>
              </section>
              <section aria-labelledby="contact-sec-h">
                <h2 id="contact-sec-h">{p.securityH}</h2>
                <p>{p.securityP}</p>
                <p>
                  <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>
                  {' · '}
                  <a href="/.well-known/security.txt">security.txt</a>
                </p>
              </section>
              <section aria-labelledby="contact-office-h">
                <OfficeBlock locale={locale} headingId="contact-office-h" />
              </section>
              <p className="muted small">{p.company}</p>
              <p className="legal-back">
                <PageLink href={HOME[locale]}>{c.legalPages.back}</PageLink>
              </p>
            </article>
          </div>
        </section>
      </main>
      <Footer locale={locale} />
    </>
  );
}
