import Link from 'next/link';
import { BRAND, whatsappDisplay, whatsappUrl } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { HOME, SECURITY_EMAIL, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { OfficeBlock } from './OfficeBlock';
import { SiteLink } from './SiteLink';

export function ContactPage({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const p = c.contactPage;
  const en = locale === 'en';
  return (
    <>
      <Header locale={locale} page="contact" />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{p.title}</h1>
          <p className="legal-notice">{p.lead}</p>
        </header>
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
              <SiteLink href={`https://${BRAND.domains.help}${en ? '/en/' : '/'}`} locale={locale}>
                {p.helpLink}
              </SiteLink>
              {' · '}
              <SiteLink href={`https://${BRAND.domains.status}${en ? '/en' : ''}`} locale={locale}>
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
            <Link href={HOME[locale]}>{c.legalPages.back}</Link>
          </p>
        </article>
      </main>
      <Footer locale={locale} />
    </>
  );
}
