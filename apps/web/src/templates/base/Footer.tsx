'use client';

import { StoreAnchor } from '../../components/StoreLink';
import { PoweredByEbda } from '../shared/PoweredByEbda';
import { FooterLegalRow } from '../shared/FooterLegalRow';
import { FooterWhatsApp } from '../shared/FooterWhatsApp';
import type { FooterProps } from '../types';
import { FOOTER_WORDMARK_CLASS } from '../shared/wordmark';
import { useLanguage } from '../../contexts/LanguageContext';
import { footerRootPaint } from '../shared/footer-ink';
import {
  footerBranchesHeading,
  resolveFooterBranches,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';
import { ResponsiveImg } from '../../components/ResponsiveImg';

export default function MinimalFooter({
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
  hideFooterLogoMobile,
  footerLogoAutoFilter,
  theme,
  locations,
}: FooterProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = footerLogo || (isRtl && branding.logoAr ? branding.logoAr : branding.logo);

  // Minimal renders a single horizontal nav row, so per-store sections are
  // flattened into one list (preserving section order: shop -> company ->
  // support). With no footerLinks configured, fall back to the previous
  // navigation + contact strip behaviour.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
  const allLinks =
    footerSections.length > 0
      ? footerSections.flatMap(section => section.links)
      : [
          ...navigation.map(item => ({
            label: isRtl && item.labelAr ? item.labelAr : item.label,
            href: item.href,
          })),
          ...(contact.email ? [{ label: contact.email, href: `mailto:${contact.email}` }] : []),
          ...(contact.phone ? [{ label: contact.phone, href: `tel:${contact.phone}` }] : []),
        ];

  // Collect active socials with brand-correct SVG icons. The shared helper
  // also synthesises a wa.me entry from `contact.whatsapp` when no full
  // social URL is set, so the merchant's contact phone doubles as a chat
  // link without manual configuration.
  const socialLinks = getSocialLinks(socials, contact, theme?.socialOrder);

  // Opt-in "Branches" block — see resolveFooterBranches for the gating
  // rules. Minimal's footer is a single flex row, not a grid, so this is
  // just another flex item rather than a "column count" to recompute.
  const branches = resolveFooterBranches(locations, theme, isRtl);
  const showBranches = branches.length > 0;

  return (
    <footer
      data-zone="footer"
      {...footerRootPaint(bgColor)}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} mt-auto py-12 md:py-16`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Single-row layout: logo · links · copyright */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {displayLogo && !hideFooterLogoMobile && (
            <ResponsiveImg
              src={displayLogo}
              alt={displayName}
              sizes="240px"
              maxWidth={480}
              className="md:hidden mx-auto h-16 w-auto object-contain mb-5"
              style={
                !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                  ? { filter: footerLogoAutoFilter }
                  : undefined
              }
            />
          )}
          {!displayLogo && !hideFooterLogoMobile && (
            <p
              data-footer-brand="mobile"
              className={
                theme?.wordmarkSize
                  ? `md:hidden self-center ${FOOTER_WORDMARK_CLASS}`
                  : 'md:hidden self-center text-xs tracking-[0.25em] ui-caps-toggle font-light text-foreground'
              }
              translate="no"
            >
              {displayName}
            </p>
          )}
          {/* Brand — desktop only (Ahmad 2026-06-20: mobile logo is now centered at the top). */}
          <div className="hidden md:block flex-shrink-0">
            {displayLogo ? (
              <ResponsiveImg
                src={displayLogo}
                alt={displayName}
                sizes="240px"
                maxWidth={480}
                className="h-16 sm:h-20 w-auto object-contain"
                style={
                  // Custom footerLogo is trusted as-is. For the brand-logo
                  // fallback, apply the pre-computed auto-contrast filter so
                  // the logo is always readable against the footer background.
                  !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                    ? { filter: footerLogoAutoFilter }
                    : undefined
                }
              />
            ) : (
              <span
                data-footer-brand="desktop"
                translate="no"
                className={
                  theme?.wordmarkSize
                    ? FOOTER_WORDMARK_CLASS
                    : 'text-xs tracking-[0.25em] ui-caps-toggle font-light text-foreground'
                }
              >
                {displayName}
              </span>
            )}
          </div>

          {/* Navigation links — horizontal, minimal */}
          {allLinks.length > 0 && (
            <nav className="flex flex-wrap gap-x-6 gap-y-2">
              {allLinks.map(({ label, href }) => (
                <StoreAnchor
                  key={href}
                  href={href}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm tracking-wide text-muted-foreground hover:text-foreground transition-colors duration-200"
                >
                  {label}
                </StoreAnchor>
              ))}
            </nav>
          )}

          {/* S-02: the store's WhatsApp, named (the social row only has an icon). */}
          {contact.whatsapp && (
            <FooterWhatsApp
              whatsapp={contact.whatsapp}
              className="text-sm tracking-wide text-muted-foreground hover:text-foreground transition-colors duration-200"
            />
          )}

          {/* Social — only render the row when at least one social link is
              configured, so empty stores don't show a hollow column. */}
          {socialLinks.length > 0 && (
            <div className="flex items-center gap-4">
              {socialLinks.map(s => (
                <a
                  key={s.key}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-foreground overflow-hidden rounded-md transition-colors duration-200 cursor-pointer"
                  aria-label={s.key}
                >
                  <SocialGlyph
                    entry={s}
                    className="w-7 h-7"
                    originalColors={theme?.footerSocialOriginalColor === true}
                  />
                </a>
              ))}
            </div>
          )}

          {/* Branches — opt-in, only rendered when the toggle is on AND at
              least one published location exists. */}
          {showBranches && (
            <div className={`flex flex-col gap-3 items-start`}>
              <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-light text-foreground">
                {footerBranchesHeading(isRtl)}
              </h4>
              <ul className="flex flex-col gap-2 text-start">
                {branches.map(loc => (
                  <li key={loc.id} className="text-sm text-muted-foreground">
                    <p className="text-foreground">{loc.name}</p>
                    {loc.mapsHref ? (
                      <a
                        href={loc.mapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-foreground transition-colors duration-200"
                      >
                        {loc.address}
                      </a>
                    ) : (
                      <span>{loc.address}</span>
                    )}
                    {loc.phone && (
                      <a
                        href={`tel:${loc.phone}`}
                        dir="ltr"
                        className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-foreground transition-colors duration-200"
                      >
                        {loc.phone}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Legal row (S-01): privacy · terms · returns · ©, from resolveBottomBar. */}
        <FooterLegalRow
          footerLinks={footerLinks}
          disabledCmsSlugs={disabledCmsSlugs}
          storeName={displayName ?? ''}
          isRtl={isRtl}
          urlPrefix={urlPrefix}
          className="text-muted-foreground"
        />
        <PoweredByEbda hidden={hidePoweredBy} />
      </div>
    </footer>
  );
}
