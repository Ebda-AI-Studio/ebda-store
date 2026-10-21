import Link from 'next/link';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { FEATURES_PAGE } from '../lib/capabilities';
import { WhatsApp } from './WhatsApp';
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
  const anchor = (id: string) =>
    page === '' && !offHome ? `#${id}` : `${home === '/' ? '' : home}/#${id}`;
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <Link
          href={home}
          className="wordmark"
          aria-label={locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn}
        >
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="wm-name">
            {locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn}
          </span>
        </Link>
        <nav aria-label={c.nav.label} className="nav">
          <ul className="nav-links">
            {NAV_ANCHORS.map(n => (
              <li key={n.key}>
                <a href={anchor(n.target)}>{c.nav[n.key]}</a>
              </li>
            ))}
            <li>
              <Link href={pagePath(locale, 'features')}>{FEATURES_PAGE[locale].navLabel}</Link>
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
              {NAV_ANCHORS.map(n => (
                <li key={n.key}>
                  <a href={anchor(n.target)}>{c.nav[n.key]}</a>
                </li>
              ))}
              <li>
                <Link href={pagePath(locale, 'features')}>{FEATURES_PAGE[locale].navLabel}</Link>
              </li>
              <li className="menu-wa">
                <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} />
              </li>
              <li className="menu-lang">
                <Link href={pagePath(other, page)} hrefLang={other} lang={other}>
                  {c.nav.switchTo}
                </Link>
              </li>
              <li className="menu-login">
                <a href={LOGIN_URL}>{c.nav.login}</a>
              </li>
            </ul>
          </details>
        </nav>
        <div className="header-actions">
          <Link
            href={pagePath(other, page)}
            hrefLang={other}
            lang={other}
            className="lang-toggle"
            aria-label={c.nav.switchLabel}
          >
            {c.nav.switchTo}
          </Link>
          <a href={LOGIN_URL} className="link-login">
            {c.nav.login}
          </a>
          <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} compact />
          <a href={SIGNUP_URL} className="btn btn-primary">
            {c.nav.start}
          </a>
        </div>
      </div>
    </header>
  );
}
