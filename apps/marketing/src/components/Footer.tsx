import Link from 'next/link';
import { BRAND } from '@force/shared/brand';
import { COPY } from '../lib/content';
import { COMPANY_URL, pagePath, type Locale } from '../lib/site';

export function Footer({ locale }: { locale: Locale }) {
  const c = COPY[locale].footer;
  return (
    <footer className="site-footer">
      <div className="wrap footer-row">
        <div>
          <p className="footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/lockup-dark.svg"
              alt={`${BRAND.name} ${BRAND.nameAr}`}
              className="footer-mark"
              width={72}
              height={24}
            />
          </p>
          <p className="muted">
            {c.byPrefix}{' '}
            <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer">
              {BRAND.company}
            </a>
          </p>
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
            <li>
              <Link href={pagePath(locale, 'merchant-agreement')}>{c.merchant}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'acceptable-use')}>{c.acceptableUse}</Link>
            </li>
          </ul>
          <p className="muted small">{c.draftNote}</p>
        </nav>
      </div>
    </footer>
  );
}
