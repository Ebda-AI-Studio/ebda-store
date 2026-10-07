'use client';

/**
 * Dahab footer: the wordmark and the store's own line, the merchant's link
 * columns (store.settings.footerLinks; the main navigation when none are
 * set), contact and branches, socials, then a bottom row of payment marks.
 * The marks are drawn transparent in the ivory ink — no white tiles on the
 * night surface. Newsletter signup is a page section on Dahab (builder
 * `newsletter`), so the footer does not repeat it.
 */
import Link from 'next/link';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { PoweredByForce } from '../shared/PoweredByForce';
import {
  footerBranchesHeading,
  resolveAddressHref,
  resolveFooterBranches,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';
import { DAHAB_CONTAINER, cx } from './ui';

const LINK =
  'inline-flex min-h-[40px] items-center text-sm text-foreground/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm';
const HEAD = 'font-display mb-4 text-lg text-foreground rtl:text-xl';

function Mark({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <li
      aria-label={label}
      className="flex h-7 items-center rounded-[3px] border border-foreground/20 px-2.5 text-[11px] font-medium text-foreground/70"
    >
      {children}
    </li>
  );
}

export function DahabPaymentMarks({ className }: { className?: string }) {
  const { t } = useLanguage();
  return (
    <ul
      className={cx('flex flex-wrap items-center gap-2', className)}
      aria-label={t('Ways to pay', 'طرق الدفع')}
    >
      <Mark label="Visa">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-8" aria-hidden="true">
          <path d="M9.112 8.262 5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 0 1 .894.764l.817 4.338 2.018-5.102h2.037Zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 0 1 1.913.336l.34-1.59a5.207 5.207 0 0 0-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.013 1.08.963 1.683 1.7 2.042.757.367 1.011.603 1.007.931-.005.503-.603.726-1.161.734-.976.015-1.541-.264-1.994-.474l-.352 1.645c.454.208 1.29.39 2.156.398 2.037 0 3.37-1.006 3.378-2.568Zm5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 0 0-.826.55l-2.909 6.946h2.036l.405-1.12h2.488l.233 1.12Zm-2.166-2.656 1.02-2.815.588 2.815h-1.608Zm-8.16-4.84-1.603 7.496H8.34l1.605-7.496h1.935Z" />
        </svg>
      </Mark>
      <Mark label="Mastercard">
        <svg
          viewBox="0 0 30 18"
          className="h-4 w-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <circle cx="11" cy="9" r="7" />
          <circle cx="19" cy="9" r="7" />
        </svg>
      </Mark>
      <Mark label="Meeza">Meeza</Mark>
      <Mark label="InstaPay">InstaPay</Mark>
      <Mark label="Fawry">Fawry</Mark>
      <Mark label={t('Cash on delivery', 'الدفع عند الاستلام')}>
        {t('Cash on delivery', 'الدفع عند الاستلام')}
      </Mark>
    </ul>
  );
}

export default function DahabFooter({
  branding,
  hidePoweredBy,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  bgColor,
  footerLogo,
  footerLogoAutoFilter,
  theme,
  locations,
}: FooterProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const name = (isRtl && branding.nameAr ? branding.nameAr : branding.name) || '';
  const logo = footerLogo || (isRtl && branding.logoAr ? branding.logoAr : branding.logo);
  const description =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const phone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const address = isRtl && contact.addressAr ? contact.addressAr : contact.address;
  const addressHref = resolveAddressHref(address, contact.addressUrl, contact.addressLink);
  const sections = resolveFooterSections(footerLinks, isRtl);
  const socialLinks = getSocialLinks(socials, contact, theme?.socialOrder);
  const branches = resolveFooterBranches(locations, theme, isRtl);
  const year = new Date().getFullYear();

  return (
    <footer
      className={cx(
        'mt-auto border-t border-border',
        !bgColor && 'bg-[hsl(var(--bg-section-alt))]'
      )}
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className={cx(DAHAB_CONTAINER, 'grid gap-10 py-14 sm:py-16 md:grid-cols-12 lg:py-20')}>
        <div className="md:col-span-4">
          {logo ? (
            <img
              src={logo}
              alt={name}
              className="h-14 w-auto object-contain"
              style={
                !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                  ? { filter: footerLogoAutoFilter }
                  : undefined
              }
            />
          ) : (
            <p className="font-display text-3xl text-primary rtl:text-4xl">{name}</p>
          )}
          {description && (
            <p className="mt-5 max-w-[38ch] text-sm leading-relaxed text-foreground/70">
              {description}
            </p>
          )}
          {socialLinks.length > 0 && (
            <ul className="mt-6 flex flex-wrap gap-1" aria-label={t('Follow us', 'تابعنا')}>
              {socialLinks.map(s => (
                <li key={s.key}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={s.key}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-foreground/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SocialGlyph
                      entry={s}
                      className="h-5 w-5"
                      originalColors={theme?.footerSocialOriginalColor === true}
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-8">
          {sections.length > 0 ? (
            sections.map(section => (
              <div key={section.key}>
                <h2 className={HEAD}>{section.heading}</h2>
                <ul>
                  {section.links.map(link => (
                    <li key={link.href}>
                      <Link href={link.href} className={LINK}>
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div>
              <h2 className={HEAD}>{t('Shop', 'تسوق')}</h2>
              <ul>
                {navigation.slice(0, 6).map(item => (
                  <li key={item.href}>
                    <Link href={item.href} className={LINK}>
                      {isRtl && item.labelAr ? item.labelAr : item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(contact.email || phone || address) && (
            <div>
              <h2 className={HEAD}>{t('Visit and contact', 'زورونا وتواصلوا')}</h2>
              <ul className="space-y-1 text-sm">
                {phone && (
                  <li>
                    <a href={`tel:${contact.phone}`} dir="ltr" className={LINK}>
                      {phone}
                    </a>
                  </li>
                )}
                {contact.email && (
                  <li>
                    <a href={`mailto:${contact.email}`} className={cx(LINK, 'break-all')}>
                      {contact.email}
                    </a>
                  </li>
                )}
                {address && (
                  <li className="leading-relaxed">
                    {addressHref ? (
                      <a
                        href={addressHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={LINK}
                      >
                        {address}
                      </a>
                    ) : (
                      <span className="text-foreground/70">{address}</span>
                    )}
                  </li>
                )}
              </ul>
            </div>
          )}

          {branches.length > 0 && (
            <div>
              <h2 className={HEAD}>{footerBranchesHeading(isRtl)}</h2>
              <ul className="space-y-3 text-sm">
                {branches.map(loc => (
                  <li key={loc.id}>
                    <p className="text-foreground/90">{loc.name}</p>
                    {loc.mapsHref ? (
                      <a
                        href={loc.mapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={LINK}
                      >
                        {loc.address}
                      </a>
                    ) : (
                      <span className="text-foreground/70">{loc.address}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/70">
        <div
          className={cx(
            DAHAB_CONTAINER,
            'flex flex-col gap-5 py-6 md:flex-row md:items-center md:justify-between'
          )}
        >
          <DahabPaymentMarks />
          <p className="text-xs text-foreground/60">
            © {year} {name}
          </p>
        </div>
        <div className={DAHAB_CONTAINER}>
          <PoweredByForce hidden={hidePoweredBy} />
        </div>
      </div>
    </footer>
  );
}
