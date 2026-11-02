import Link from 'next/link';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { CookieSettingsButton } from './CookieSettingsButton';
import {
  SECURITY_EMAIL,
  STORE_HOME,
  pagePath,
  productOfPage,
  type Locale,
  type PageSlug,
} from '../lib/site';

export function Footer({ locale, page = '' }: { locale: Locale; page?: PageSlug }) {
  const kind = productOfPage(page);
  const wa = kind === 'whatsapp';
  const studio = kind === 'studio';
  const c = COPY[locale].footer;
  const k = COPY[locale].contact;
  return (
    <footer className="site-footer band-dark">
      <div className="wrap footer-row">
        <div>
          <p className="footer-brand">
            <img src="/icon.svg" alt="" className="footer-mark" width={28} height={28} />
            <span>{locale === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn}</span>
          </p>
          <p className="footer-credit">{wa ? c.waProduct : studio ? c.studioProduct : c.product}</p>
          <p className="footer-h">{k.title}</p>
          <dl className="footer-contact">
            <div>
              <dt>{k.hello}</dt>
              <dd>
                <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
              </dd>
            </div>
            <div>
              <dt>{k.security}</dt>
              <dd>
                <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>
              </dd>
            </div>
          </dl>
        </div>
        <nav aria-label={c.legalNav}>
          <ul className="footer-links">
            {studio && (
              <li>
                <Link href={STORE_HOME[locale]}>
                  {locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn}
                </Link>
              </li>
            )}
            <li>
              <Link href={pagePath(locale, 'features')}>{COPY[locale].nav.features}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'whatsapp')}>
                {locale === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn}
              </Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'about')}>{c.about}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'contact')}>{COPY[locale].nav.contact}</Link>
            </li>
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
            <li>
              <Link href={pagePath(locale, 'legal/data-deletion')}>{c.dataDeletion}</Link>
            </li>
            <li>
              <Link href={pagePath(locale, 'credits')}>{c.credits}</Link>
            </li>
            <li>
              <CookieSettingsButton label={c.cookies} />
            </li>
          </ul>
          <p className="muted small">{c.legalVersion}</p>
        </nav>
      </div>
      <div className="wrap footer-legal">
        <p className="muted small">
          {wa ? c.waOwnership : studio ? c.studioOwnership : c.ownership}
        </p>
      </div>
    </footer>
  );
}
