import Link from 'next/link';
import { BRAND } from '@force/shared/brand';
import { COPY } from '../lib/content';
import { HOME, LOGIN_URL, NAV_ANCHORS, SIGNUP_URL, pagePath, type Locale } from '../lib/site';

type Page = '' | 'legal' | 'privacy' | 'terms';

export function Header({ locale, page = '' }: { locale: Locale; page?: Page }) {
  const c = COPY[locale];
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const home = HOME[locale];
  const anchor = (id: string) => (page === '' ? `#${id}` : `${home === '/' ? '' : home}/#${id}`);
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <Link href={home} className="wordmark" aria-label={`${BRAND.name} ${BRAND.nameAr}`}>
          <span className="wm-latin">EBDA</span>
          <span className="wm-ar" lang="ar">
            {BRAND.nameAr}
          </span>
        </Link>
        <nav aria-label={c.nav.label} className="nav">
          <ul className="nav-links">
            {NAV_ANCHORS.map(n => (
              <li key={n.key}>
                <a href={anchor(n.target)}>{c.nav[n.key]}</a>
              </li>
            ))}
          </ul>
          <details className="nav-menu">
            <summary>{c.nav.menu}</summary>
            <ul>
              {NAV_ANCHORS.map(n => (
                <li key={n.key}>
                  <a href={anchor(n.target)}>{c.nav[n.key]}</a>
                </li>
              ))}
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
          <a href={SIGNUP_URL} className="btn btn-primary">
            {c.nav.start}
          </a>
        </div>
      </div>
    </header>
  );
}
