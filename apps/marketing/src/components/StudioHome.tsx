import Link from 'next/link';
import { BRAND, SITE_NAV_ICONS, type SiteNavProductId } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { STUDIO_HOME } from '../lib/studio-home';
import { SIGNUP_URL, STORE_HOME, pagePath, type Locale } from '../lib/site';
import { WHATSAPP_APP_URL } from '../lib/whatsapp-page';
import { studioJsonLd } from '../lib/seo';
import { Footer } from './Footer';
import { Header } from './Header';
import { ServicesGrid } from './ServicesGrid';
import { GirihPoster, WindowGirih } from './GirihPoster';
import { JsonLd } from './JsonLd';
import { SiteLink } from './SiteLink';

function Icon({ id, mirror = false }: { id: SiteNavProductId; mirror?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
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
 * The Ebda AI Studio home (`/`, `/en`), Rulings MKT-HOME-1 and MKT-STUDIO-C-1: "living geometry". The hero is a full-bleed girih
 * lattice in Ebda gold on ivory (static SVG first, then one canvas from `/studio-pattern.js` loaded after `load`, which breathes,
 * answers the pointer and turns with scroll); Ebda Store (8-fold star) and Ebda Chat (12-point star) are windows cut into it. All text
 * is DOM, never canvas. Below the hero sits a typographic grid: big Arabic display type, gold hairlines, numbers only for the steps.
 * The Store landing itself moved, unchanged, to /store (Ruling MKT-STORE-FROZEN-1); `hash-forward.js` forwards old `/#pricing` links.
 */
const LOADER =
  "(function(){var m=matchMedia('(prefers-reduced-motion: reduce)');if(m.matches)return;var c=navigator.connection;if(c&&c.saveData)return;" +
  "function l(){var s=document.createElement('script');s.src='/studio-pattern.js';s.async=true;document.head.appendChild(s)}" +
  "addEventListener('load',function(){window.requestIdleCallback?requestIdleCallback(l,{timeout:2000}):setTimeout(l,300)})})()";

export function StudioHomePage({ locale }: { locale: Locale }) {
  const c = STUDIO_HOME[locale];
  const rtl = locale === 'ar';
  const store = rtl ? BRAND.product.nameAr : BRAND.product.nameEn;
  const chat = rtl ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn;
  // Western digits in every locale (Ruling DIGITS-1).
  const num = (n: number) => ['01', '02', '03'][n];
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={studioJsonLd(locale)} />
      <Header locale={locale} page="" />
      <main id="main" className="studio-home">
        <section className="sh-hero" aria-labelledby="sh-h1">
          <div className="sh-art" aria-hidden="true">
            <GirihPoster />
            <canvas className="sh-canvas" data-pattern-canvas />
          </div>
          <div className="wrap sh-hero-in">
            <header className="sh-head">
              <p className="sh-eyebrow">{c.eyebrow}</p>
              <h1 id="sh-h1">{c.h1}</h1>
              <p className="sh-lead">{c.lead}</p>
            </header>
            <ul className="sh-windows">
              <li className="sh-win" data-win="8">
                <WindowGirih id="g8w" />
                <div className="sh-win-in">
                  <h2>
                    <Icon id="store" />
                    {store}
                  </h2>
                  <p className="sh-win-p">{c.store.blurb}</p>
                  <p className="actions">
                    <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
                      {c.store.cta}
                    </SiteLink>
                    <Link href={STORE_HOME[locale]} className="btn btn-ghost btn-lg">
                      {c.store.more}
                    </Link>
                  </p>
                </div>
              </li>
              <li className="sh-win" data-win="12">
                <WindowGirih id="g12w" />
                <div className="sh-win-in">
                  <h2>
                    <Icon id="whatsapp" mirror={rtl} />
                    {chat}
                  </h2>
                  <p className="sh-win-p">{c.chat.blurb}</p>
                  <p className="actions">
                    <SiteLink
                      href={WHATSAPP_APP_URL}
                      locale={locale}
                      className="btn btn-primary btn-lg"
                    >
                      {c.chat.cta}
                    </SiteLink>
                    <Link href={pagePath(locale, 'whatsapp')} className="btn btn-ghost btn-lg">
                      {c.chat.more}
                    </Link>
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section className="sh-sec" aria-labelledby="sh-does-h" id="studio">
          <div className="wrap sh-grid">
            <h2 className="sh-label" id="sh-does-h">
              {c.does.label}
            </h2>
            <div className="sh-body">
              <p className="sh-statement">{c.does.statement}</p>
              <ServicesGrid locale={locale} />
            </div>
          </div>
        </section>

        <section className="sh-sec" aria-labelledby="sh-products-h" id="products">
          <div className="wrap sh-grid">
            <h2 className="sh-label" id="sh-products-h">
              {c.products.label}
            </h2>
            <ul className="sh-body sh-rows">
              <li>
                <h3>{store}</h3>
                <p>{c.store.blurb}</p>
                <ul className="sh-facts">
                  {c.products.storeFacts.map(t => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p className="actions">
                  <Link href={STORE_HOME[locale]} className="btn btn-ghost">
                    {c.store.more}
                  </Link>
                </p>
              </li>
              <li>
                <h3>{chat}</h3>
                <p>{c.chat.blurb}</p>
                <ul className="sh-facts">
                  {c.products.chatFacts.map(t => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p className="actions">
                  <Link href={pagePath(locale, 'whatsapp')} className="btn btn-ghost">
                    {c.chat.more}
                  </Link>
                </p>
              </li>
            </ul>
          </div>
        </section>

        <section className="sh-sec" aria-labelledby="sh-steps-h" id="start">
          <div className="wrap sh-grid">
            <h2 className="sh-label" id="sh-steps-h">
              {c.steps.label}
            </h2>
            <div className="sh-body">
              <p className="sh-statement">{c.steps.h}</p>
              <ol className="sh-steps">
                {c.steps.items.map((i, n) => (
                  <li key={i.h}>
                    <span className="sh-no" aria-hidden="true">
                      {num(n)}
                    </span>
                    <h3>{i.h}</h3>
                    <p>{i.p}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="sh-sec sh-last" aria-labelledby="sh-trust-h" id="trust">
          <div className="wrap sh-grid">
            <h2 className="sh-label" id="sh-trust-h">
              {c.trust.label}
            </h2>
            <div className="sh-body">
              <p className="sh-statement">{c.trust.h}</p>
              <ul className="sh-trio">
                {c.trust.items.map(i => (
                  <li key={i.h}>
                    <h3>{i.h}</h3>
                    <p>{i.p}</p>
                  </li>
                ))}
              </ul>
              <p className="actions">
                <Link href={pagePath(locale, 'contact')} className="btn btn-primary btn-lg">
                  {c.trust.contactCta}
                </Link>
                <Link href={pagePath(locale, 'terms')} className="btn btn-ghost btn-lg">
                  {c.trust.legalLabel}
                </Link>
              </p>
              <p className="muted small">{c.account}</p>
            </div>
          </div>
        </section>
      </main>
      <Footer locale={locale} page="" />
      <script src="/hash-forward.js" defer />
      <script dangerouslySetInnerHTML={{ __html: LOADER }} />
    </>
  );
}
