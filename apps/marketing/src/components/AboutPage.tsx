import Link from 'next/link';
import {
  BRAND,
  BRAND_SECURITY_EMAIL,
  siteNavProducts,
  whatsappDisplay,
  whatsappUrl,
} from '@ebda/shared/brand';
import { formatLegalDate } from '@ebda/shared/legal';
import { COPY } from '../lib/content';
import { pagePath, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { OfficeBlock } from './OfficeBlock';
import { SiteLink } from './SiteLink';
import { JsonLd } from './JsonLd';
import { studioJsonLd } from '../lib/seo';

/**
 * The About page, a STUDIO page: what Ebda AI Studio is (an Egyptian studio for AI, software and digital marketing), what
 * it does, its two products, the doorway story, how it works, how to reach it, and one small legal-entity line. Only facts
 * the brand module and the product pages hold: no founding date, team, funding or address. Each section carries one
 * medallion from public/motifs and a gold hairline under its heading; no calligraphy and no arch (those are the home's).
 */
export function AboutPage({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const p = c.aboutPage;
  const products = siteNavProducts(locale);
  return (
    <>
      <JsonLd data={studioJsonLd(locale)} />
      <Header locale={locale} page="about" />
      <main id="main" className="ab">
        <header className="wrap ab-hero">
          <p className="ab-eyebrow">{p.eyebrow}</p>
          <h1>{p.title}</h1>
          <p className="ab-lead">{p.lead}</p>
          <p className="ab-founded muted">
            {p.foundedLabel}{' '}
            <time dateTime={BRAND.company.foundedOn}>
              {formatLegalDate(BRAND.company.foundedOn, locale)}
            </time>
          </p>
          <p className="about-line" lang={locale}>
            {p.brandLine}
          </p>
        </header>

        <section className="ab-sec ab-m8" aria-labelledby="ab-do-h">
          <div className="wrap">
            <h2 className="ab-h2" id="ab-do-h">
              {p.doH}
            </h2>
            <ul className="ab-grid ab-grid-3">
              {p.doItems.map(i => (
                <li key={i.t}>
                  <h3>{i.t}</h3>
                  <p>{i.d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="ab-sec ab-mr" aria-labelledby="ab-products-h">
          <div className="wrap">
            <h2 className="ab-h2" id="ab-products-h">
              {p.productsH}
            </h2>
            <ul className="ab-grid ab-grid-2">
              {products.map(pr => (
                <li key={pr.id} className="ab-card">
                  <h3>{pr.label}</h3>
                  <p>{pr.blurb}</p>
                  <Link href={pr.path!} className="btn btn-ghost">
                    {p.productCta} {pr.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="ab-sec ab-mq" aria-labelledby="about-story-h">
          <div className="wrap ab-story">
            <h2 className="ab-h2" id="about-story-h">
              {p.storyH}
            </h2>
            {c.about.paras.map(t => (
              <p key={t}>{t}</p>
            ))}
            <p className="ab-close" lang="ar">
              {c.about.close}
            </p>
          </div>
        </section>

        <section className="ab-sec ab-m8" aria-labelledby="ab-how-h">
          <div className="wrap">
            <h2 className="ab-h2" id="ab-how-h">
              {p.howH}
            </h2>
            <ul className="ab-grid ab-grid-4">
              {p.howItems.map(i => (
                <li key={i.t}>
                  <h3>{i.t}</h3>
                  <p>{i.d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="ab-sec ab-mr" aria-labelledby="about-contact-h">
          <div className="wrap ab-story">
            <h2 className="ab-h2" id="about-contact-h">
              {p.contactH}
            </h2>
            <p>
              <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
              {' · '}
              <a href={`mailto:${BRAND_SECURITY_EMAIL}`}>{BRAND_SECURITY_EMAIL}</a>
              {' · '}
              <SiteLink href={whatsappUrl()} locale={locale} dir="ltr">
                {whatsappDisplay()}
              </SiteLink>
            </p>
            <OfficeBlock locale={locale} />
            <p className="muted">{p.contactHelp}</p>
            <p>
              <Link href={pagePath(locale, 'contact')}>{c.nav.contact}</Link>
            </p>
          </div>
        </section>

        <p className="wrap ab-legal muted small">
          {p.legalLabel}: {locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn}
          {' · '}
          <Link href={pagePath(locale, 'legal')}>{p.legalLink}</Link>
        </p>
      </main>
      <Footer locale={locale} />
    </>
  );
}
