import Link from 'next/link';
import { BRAND, SITE_NAV_ICONS, type SiteNavProductId } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { NavBehavior } from './NavBehavior';
import { SiteLink } from './SiteLink';
import { WhatsApp } from './WhatsApp';
import { HeaderSearch } from './HeaderSearch';
import {
  HOME,
  LOGIN_URL,
  NAV_ANCHORS,
  SIGNUP_URL,
  pagePath,
  type Locale,
  type PageSlug,
} from '../lib/site';

type Page = PageSlug;

/** Nav anchors that move into the "More" menu on desktop (the mobile menu lists everything). */
const MORE_KEYS: readonly string[] = ['resources'];

/** The product icon (shared paths from the brand module, so docs/help/status draw the same one). */
function ProductIcon({ id }: { id: SiteNavProductId }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
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

/** `offHome`: rendered on a page that is not the home (the 404), so nav anchors link to the home. */
export function Header({
  locale,
  page = '',
  offHome = false,
}: {
  locale: Locale;
  page?: Page;
  offHome?: boolean;
}) {
  const c = COPY[locale];
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const home = HOME[locale];
  /** The master brand (BRAND-ARCH-1): the studio lockup, never a bare product or a bare Ebda. */
  const studio = locale === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  /** The Products menu: Ebda Store, then Ebda WhatsApp (the same two entries as docs, help and status; BRAND-ARCH-1). */
  const products = [
    {
      id: 'store' as const,
      href: home,
      name: locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn,
      blurb: c.nav.storeBlurb,
    },
    {
      id: 'whatsapp' as const,
      href: pagePath(locale, 'whatsapp'),
      name: locale === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn,
      blurb: c.nav.whatsappBlurb,
    },
  ];
  const anchor = (id: string) =>
    page === '' && !offHome ? `#${id}` : `${home === '/' ? '' : home}/#${id}`;
  /** "Features" is the real /features/ page; every other item is a home section, absolute off the home. */
  const navLink = (n: (typeof NAV_ANCHORS)[number]) =>
    n.key === 'features' ? (
      <Link href={pagePath(locale, 'features')}>{c.nav.features}</Link>
    ) : (
      <a href={anchor(n.target)}>{c.nav[n.key]}</a>
    );
  /** Secondary destinations live in one "More" menu so the top row stays on one line at every desktop width. */
  const moreItems = [
    ...NAV_ANCHORS.filter(n => MORE_KEYS.includes(n.key)).map(n => ({
      key: n.key,
      node: navLink(n),
    })),
    { key: 'about', node: <Link href={pagePath(locale, 'about')}>{c.nav.about}</Link> },
    { key: 'contact', node: <Link href={pagePath(locale, 'contact')}>{c.nav.contact}</Link> },
  ];
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <Link href={home} className="wordmark" aria-label={studio}>
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="wm-name">{studio}</span>
        </Link>
        <nav aria-label={c.nav.label} className="nav">
          <ul className="nav-links">
            <li className="nav-products">
              <details>
                <summary>{c.nav.products}</summary>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <Link href={p.href}>
                        <span className="np-ico">
                          <ProductIcon id={p.id} />
                        </span>
                        <span className="np-txt">
                          <b>{p.name}</b>
                          <span>{p.blurb}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            {NAV_ANCHORS.filter(n => !MORE_KEYS.includes(n.key)).map(n => (
              <li key={n.key}>{navLink(n)}</li>
            ))}
            <li className="nav-products nav-more">
              <details>
                <summary>{c.nav.more}</summary>
                <ul>
                  {moreItems.map(m => (
                    <li key={m.key}>{m.node}</li>
                  ))}
                </ul>
              </details>
            </li>
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
              <span className="menu-label">{c.nav.menu}</span>
            </summary>
            <ul>
              <li className="menu-group">
                <p>{c.nav.products}</p>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <Link href={p.href}>{p.name}</Link>
                    </li>
                  ))}
                </ul>
              </li>
              {NAV_ANCHORS.map(n => (
                <li key={n.key}>{navLink(n)}</li>
              ))}
              <li>
                <Link href={pagePath(locale, 'about')}>{c.nav.about}</Link>
              </li>
              <li>
                <Link href={pagePath(locale, 'contact')}>{c.nav.contact}</Link>
              </li>
              <li className="menu-wa">
                <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} />
              </li>
              <li className="menu-lang">
                <Link href={pagePath(other, page)} hrefLang={other} lang={other}>
                  {c.nav.switchTo}
                </Link>
              </li>
              <li className="menu-login">
                <SiteLink href={LOGIN_URL} locale={locale}>
                  {c.nav.login}
                </SiteLink>
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
          <SiteLink href={LOGIN_URL} locale={locale} className="link-login">
            {c.nav.login}
          </SiteLink>
          <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} compact />
          <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary">
            {c.nav.start}
          </SiteLink>
        </div>
      </div>
      <NavBehavior />
    </header>
  );
}
