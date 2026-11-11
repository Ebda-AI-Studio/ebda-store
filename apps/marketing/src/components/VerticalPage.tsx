import { SiteLink } from './SiteLink';
import { COPY } from '../lib/content';
import { jsonLd } from '../lib/seo';
import { DEMO_STORES, SIGNUP_URL, type Locale } from '../lib/site';
import { VERTICALS, verticalLooks, type VerticalSlug } from '../lib/verticals';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { BRAND } from '@ebda/shared/brand';

const K = {
  ar: {
    looks: 'ثلاثة أشكال جاهزة',
    start: 'افتح متجرك',
    demo: 'شوف متجر تجريبي',
    open: 'افتح الشكل',
    note: 'صور توضيحية',
  },
  en: {
    looks: 'Three ready looks',
    start: 'Open your store',
    demo: 'See a demo store',
    open: 'Open this look',
    note: 'Illustrative photos',
  },
} as const;

/** An ad landing page for one vertical (marketing-levelup P2): headline, the three looks, one call to sign up. */
export function VerticalPage({ locale, slug }: { locale: Locale; slug: VerticalSlug }) {
  const v = VERTICALS[slug][locale];
  const k = K[locale];
  const looks = verticalLooks(slug, locale);
  const demo = `https://${DEMO_STORES[VERTICALS[slug].template].host}${BRAND.domains.storeSuffix}/`;
  const signup = `${SIGNUP_URL}?utm_source=site&utm_medium=vertical&utm_campaign=for-${slug}`;
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={jsonLd(locale, [])} />
      <Header locale={locale} page={`for/${slug}`} />
      <main id="main" className="wrap page">
        <header className="page-head">
          <h1>{v.h1}</h1>
          <p className="lead">{v.lead}</p>
          <p className="actions">
            <SiteLink href={signup} locale={locale} className="btn btn-primary btn-lg">
              {k.start}
            </SiteLink>
            <a href={demo} className="btn btn-ghost btn-lg">
              {k.demo}
            </a>
          </p>
        </header>
        <section className="page-sec" aria-labelledby="looks-h">
          <h2 id="looks-h">{k.looks}</h2>
          <ul className="more-list">
            {looks.map(l => (
              <li key={l.id}>
                <b>{l.name}.</b> {l.idea}{' '}
                <a href={l.href}>
                  {k.open}
                  <span className="sr-only"> {l.name}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="muted small">{k.note}</p>
        </section>
        <p className="actions">
          <SiteLink href={signup} locale={locale} className="btn btn-primary btn-lg">
            {k.start}
          </SiteLink>
        </p>
      </main>
      <Footer locale={locale} />
    </>
  );
}
