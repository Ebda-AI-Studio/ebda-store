import Link from 'next/link';
import { BRAND } from '@force/shared/brand';
import { COPY } from '../lib/content';
import { pagePath, type Locale } from '../lib/site';

export function Footer({ locale }: { locale: Locale }) {
  const c = COPY[locale].footer;
  return (
    <footer className="site-footer">
      <div className="wrap footer-row">
        <div>
          <p className="footer-brand">
            <strong>EBDA</strong> <span lang="ar">{BRAND.nameAr}</span>
          </p>
          <p className="muted">{c.by}</p>
          <p className="muted">
            <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
          </p>
        </div>
        <nav aria-label={c.legalNav}>
          <ul className="footer-links">
            <li>
              <Link href={pagePath(locale, 'legal')}>{c.legal}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'privacy')}>{c.privacy}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'terms')}>{c.terms}</Link>
            </li>
          </ul>
          <p className="muted small">{c.draftNote}</p>
        </nav>
      </div>
    </footer>
  );
}
