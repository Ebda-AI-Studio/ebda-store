import Link from 'next/link';
import { BRAND, SITE_NAV_ICONS, type SiteNavProductId } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { STUDIO_HOME } from '../lib/studio-home';
import { SIGNUP_URL, STORE_HOME, pagePath, type Locale } from '../lib/site';
import { WHATSAPP_APP_URL } from '../lib/whatsapp-page';
import { studioJsonLd } from '../lib/seo';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { SiteLink } from './SiteLink';

function Icon({ id }: { id: SiteNavProductId }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      {SITE_NAV_ICONS[id].map(p => (
        <path
          key={p.d}
          d={p.d}
          fill={p.fill ? 'currentColor' : 'none'}
          stroke={p.fill ? undefined : 'currentColor'}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/**
 * The Ebda AI Studio home (`/`, `/en`), Ruling MKT-HOME-1: a short studio hero and the products grid, Ebda Store first and
 * largest with its own sign-up button. The Store landing itself moved, unchanged, to /store (Ruling MKT-STORE-FROZEN-1).
 * `hash-forward.js` sends the old `/#pricing`-style links to `/store#pricing`.
 */
export function StudioHomePage({ locale }: { locale: Locale }) {
  const c = STUDIO_HOME[locale];
  const rtl = locale === 'ar';
  const store = rtl ? BRAND.product.nameAr : BRAND.product.nameEn;
  const chat = rtl ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn;
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={studioJsonLd(locale)} />
      <Header locale={locale} page="" />
      <main id="main" className="wrap page studio-home">
        <header className="page-head">
          <p className="eyebrow">{c.eyebrow}</p>
          <h1>{c.h1}</h1>
          <p className="lead">{c.lead}</p>
        </header>
        <section aria-labelledby="studio-products-h" id="products">
          <h2 id="studio-products-h">{c.productsH}</h2>
          <ul className="studio-products">
            <li className="studio-card studio-card-store">
              <span className="np-ico">
                <Icon id="store" />
              </span>
              <h3>{store}</h3>
              <p>{c.store.blurb}</p>
              <p className="actions">
                <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
                  {c.store.cta}
                </SiteLink>
                <Link href={STORE_HOME[locale]} className="btn btn-ghost btn-lg">
                  {c.store.more}
                </Link>
              </p>
            </li>
            <li className="studio-card">
              <span className="np-ico">
                <Icon id="whatsapp" />
              </span>
              <h3>{chat}</h3>
              <p>{c.chat.blurb}</p>
              <p className="actions">
                <SiteLink href={WHATSAPP_APP_URL} locale={locale} className="btn btn-primary">
                  {c.chat.cta}
                </SiteLink>
                <Link href={pagePath(locale, 'whatsapp')} className="btn btn-ghost">
                  {c.chat.more}
                </Link>
              </p>
            </li>
          </ul>
          <p className="muted small">{c.account}</p>
        </section>
      </main>
      <Footer locale={locale} page="" />
      <script src="/hash-forward.js" defer />
    </>
  );
}
