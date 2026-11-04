'use client';

/**
 * Dahab footer: the wordmark and the store's own line, the merchant's link
 * columns (store.settings.footerLinks; the main navigation when none are
 * set), contact and branches, socials, then a bottom row of payment marks.
 * The marks are drawn transparent in the foreground ink — no white tiles on the
 * page surface. Newsletter signup is a page section on Dahab (builder
 * `newsletter`), so the footer does not repeat it.
 */
import Link from '../../components/StoreLink';
import { AcceptedPaymentBadges } from '../../components/AcceptedPaymentBadges';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { PoweredByEbda } from '../shared/PoweredByEbda';
import { FooterLegalRow } from '../shared/FooterLegalRow';
import { FooterWhatsApp } from '../shared/FooterWhatsApp';
import { footerRootPaint } from '../shared/footer-ink';
import {
  footerBranchesHeading,
  resolveAddressHref,
  resolveFooterBranches,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';
import { DAHAB_CONTAINER, cx } from './ui';
import { ResponsiveImg } from '../../components/ResponsiveImg';

const LINK =
  'inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-foreground/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm';
const HEAD = 'font-display mb-4 text-lg text-foreground rtl:text-xl';

export function DahabPaymentMarks({ className }: { className?: string }) {
  return <AcceptedPaymentBadges variant="dahab" className={className} />;
}

export default function DahabFooter({
  branding,
  hidePoweredBy,
  contact,
  socials,
  navigation = [],
  footerLinks,
  disabledCmsSlugs,
  urlPrefix,
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

  return (
    <footer
      className={cx(
        'mt-auto border-t border-border',
        !bgColor && 'bg-[hsl(var(--bg-section-alt))]'
      )}
      {...footerRootPaint(bgColor)}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className={cx(DAHAB_CONTAINER, 'grid gap-10 py-14 sm:py-16 md:grid-cols-12 lg:py-20')}>
        <div className="md:col-span-4">
          {logo ? (
            <ResponsiveImg
              src={logo}
              alt={name}
              sizes="240px"
              maxWidth={480}
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

          {(contact.email || phone || address || contact.whatsapp) && (
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
                {contact.whatsapp && (
                  <li>
                    <FooterWhatsApp whatsapp={contact.whatsapp} className={LINK} />
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
          {/* Legal row (S-01): privacy · terms · returns · ©, from resolveBottomBar.
              Dahab's bar already has its hairline above. */}
          <FooterLegalRow
            footerLinks={footerLinks}
            disabledCmsSlugs={disabledCmsSlugs}
            storeName={name}
            isRtl={isRtl}
            urlPrefix={urlPrefix}
            hairline={false}
            className="text-xs text-foreground/70"
          />
        </div>
        <div className={DAHAB_CONTAINER}>
          <PoweredByEbda hidden={hidePoweredBy} />
        </div>
      </div>
    </footer>
  );
}
