import Link from 'next/link';
import {
  SITE_NAV_ICONS,
  productBar,
  siteNavCta,
  siteNavLabels,
  siteNavLogin,
  siteNavProducts,
  siteNavResources,
  siteNavStudio,
  studioHomeLink,
  type NavLink,
  type SiteNavProductId,
} from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { NavBehavior } from './NavBehavior';
import { WhatsApp } from './WhatsApp';
import { HeaderSearch } from './HeaderSearch';
import { productOfPage, pagePath, type Locale, type PageSlug } from '../lib/site';
import '@/app/chrome.css';

type Page = PageSlug;

/**
 * One link of the shared nav data (packages/shared/src/brand): a marketing page routes client-side with next/link,
 * everything else (help, docs, status, the apps) is a plain anchor. Product-app links stay in the same tab.
 */
function NavA({
  l,
  current = false,
  className,
}: {
  l: NavLink;
  current?: boolean;
  className?: string;
}) {
  const aria = current ? ({ 'aria-current': 'page' } as const) : {};
  return l.path ? (
    <Link href={l.path} className={className} {...aria}>
      {l.label}
    </Link>
  ) : (
    <a href={l.href} className={className} {...aria}>
      {l.label}
    </a>
  );
}

/** The product icon (shared paths from the brand module, so docs/help/status draw the same one). */
function ProductIcon({ id, mirror = false }: { id: SiteNavProductId; mirror?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
      {SITE_NAV_ICONS[id].map(p =>
        p.fill ? (
          <path key={p.d} d={p.d} fill="currentColor" />
        ) : (
          <path
            key={p.d}
            d={p.d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      )}
    </svg>
  );
}

/**
 * The ONE header (public sites audit 2026-11-03, section 4): the studio bar on every page (wordmark to the studio home,
 * Products, Resources, About, Contact, language, Log in, the studio CTA) and, only on a product page, the product bar
 * under it. Its data is the brand module's (`siteNav*`, `productBar`), the same that docs, help and status render.
 * `offHome` is kept for the 404 call site: every link is absolute now, so it changes nothing.
 */
export function Header({ locale, page = '' }: { locale: Locale; page?: Page; offHome?: boolean }) {
  const c = COPY[locale];
  const lang = locale;
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const kind = productOfPage(page);
  const home = studioHomeLink(lang);
  const t = siteNavLabels(lang);
  const products = siteNavProducts(lang);
  const resources = siteNavResources(lang);
  const studio = siteNavStudio(lang);
  const login = siteNavLogin(lang);
  const cta = siteNavCta(lang);
  const bar = kind === 'studio' ? null : productBar(kind, lang);
  const here = pagePath(locale, page).replace(/\/?$/, '/');
  const cur = (l: NavLink) => !!l.path && l.path === here;
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <Link href={home.path!} className="wordmark" aria-label={home.label}>
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="wm-name">{home.label}</span>
        </Link>
        <nav aria-label={t.nav} className="nav">
          <ul className="nav-links">
            <li className="nav-products">
              <details>
                <summary>{t.products}</summary>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <Link href={p.path!}>
                        <span className="np-ico">
                          <ProductIcon id={p.id} mirror={locale === 'ar' && p.id === 'whatsapp'} />
                        </span>
                        <span className="np-txt">
                          <b>{p.label}</b>
                          <span>{p.blurb}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            <li className="nav-products">
              <details>
                <summary>{t.resources}</summary>
                <ul>
                  {resources.map(r => (
                    <li key={r.id}>
                      <NavA l={r} />
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            {studio.map(s => (
              <li key={s.id}>
                <NavA l={s} current={cur(s)} />
              </li>
            ))}
          </ul>
          <details className="nav-menu">
            <summary>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              <span className="menu-label">{t.menu}</span>
            </summary>
            <ul>
              <li className="menu-group">
                <p>{t.products}</p>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <NavA l={p} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-group">
                <p>{t.resources}</p>
                <ul>
                  {resources.map(r => (
                    <li key={r.id}>
                      <NavA l={r} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-group">
                <p>{t.studio}</p>
                <ul>
                  {studio.map(s => (
                    <li key={s.id}>
                      <NavA l={s} current={cur(s)} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-group menu-login">
                <p>{login.label}</p>
                <ul>
                  {login.items.map(i => (
                    <li key={i.id}>
                      <NavA l={i} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-wa">
                <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} />
              </li>
              <li className="menu-lang">
                <Link href={pagePath(other, page)} hrefLang={other} lang={other}>
                  {c.nav.switchTo}
                </Link>
              </li>
              <li className="menu-start">
                <NavA l={bar ? bar.cta : cta} className="nav-cta" />
              </li>
            </ul>
          </details>
        </nav>
        <div className="header-actions">
          <HeaderSearch locale={locale} />
          <Link
            href={pagePath(other, page)}
            hrefLang={other}
            lang={other}
            className="lang-toggle"
            aria-label={c.nav.switchLabel}
          >
            {c.nav.switchTo}
          </Link>
          <div className="nav-products login-menu">
            <details>
              <summary>{login.label}</summary>
              <ul>
                {login.items.map(i => (
                  <li key={i.id}>
                    <NavA l={i} />
                  </li>
                ))}
              </ul>
            </details>
          </div>
          <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} compact />
          {!bar && <NavA l={cta} className="btn btn-primary header-start" />}
        </div>
      </div>
      {bar && (
        <div className="product-bar">
          <div className="wrap product-row">
            <Link
              href={bar.chip.path!}
              className="product-chip"
              aria-current={cur(bar.chip) ? 'page' : undefined}
            >
              {bar.chip.label}
            </Link>
            <ul className="product-links">
              {bar.links.map(l => (
                <li key={l.id}>
                  <NavA l={l} current={cur(l)} />
                </li>
              ))}
            </ul>
            <NavA l={bar.cta} className="btn btn-primary btn-sm product-cta" />
          </div>
        </div>
      )}
      <NavBehavior />
    </header>
  );
}
