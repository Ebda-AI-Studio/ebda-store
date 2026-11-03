import Link from 'next/link';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { HOME, SECURITY_EMAIL, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { studioJsonLd } from '../lib/seo';

export function AboutPage({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const p = c.aboutPage;
  return (
    <>
      <JsonLd data={studioJsonLd(locale)} />
      <Header locale={locale} page="about" />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{p.title}</h1>
          <p className="legal-notice">{p.company}</p>
          <p className="about-line" lang={locale}>
            {p.brandLine}
          </p>
        </header>
        <article className="legal-doc">
          <section aria-labelledby="about-story-h">
            <h2 id="about-story-h">{p.storyH}</h2>
            {c.about.paras.map(t => (
              <p key={t}>{t}</p>
            ))}
            <p lang="ar">{c.about.close}</p>
          </section>
          <section aria-labelledby="about-contact-h">
            <h2 id="about-contact-h">{p.contactH}</h2>
            <p>
              <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
              {' · '}
              <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>
            </p>
          </section>
          <p className="legal-back">
            <Link href={HOME[locale]}>{c.legalPages.back}</Link>
          </p>
        </article>
      </main>
      <Footer locale={locale} />
    </>
  );
}
