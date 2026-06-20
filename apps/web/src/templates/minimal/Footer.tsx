'use client';

import { PoweredByForce } from '../shared/PoweredByForce';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { resolveFooterSections } from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';

export default function MinimalFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  bgColor,
  footerLogo,
  hideFooterLogoMobile,
  footerLogoAutoFilter,
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
  const socialLinks = getSocialLinks(socials, contact);

  return (
    <footer
      data-zone="footer"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} mt-auto py-12 md:py-16`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-6">
        {/* Single-row layout: logo · links · copyright */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {displayLogo && !hideFooterLogoMobile && (
            <img
              src={displayLogo}
              alt={displayName}
              className="md:hidden mx-auto h-16 w-auto object-contain mb-5"
              style={
                !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                  ? { filter: footerLogoAutoFilter }
                  : undefined
              }
            />
          )}
          {/* Brand — desktop only (Ahmad 2026-06-20: mobile logo is now centered at the top). */}
          <div className="hidden md:block flex-shrink-0">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
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
              <span className="text-xs tracking-[0.25em] uppercase font-light text-foreground">
                {displayName}
              </span>
            )}
          </div>

          {/* Navigation links — horizontal, minimal */}
          {allLinks.length > 0 && (
            <nav className={`flex flex-wrap gap-x-6 gap-y-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {allLinks.map(({ label, href }) => (
                <a
                  key={href}
                  href={href}
                  className="text-sm tracking-wide text-muted-foreground hover:text-foreground transition-colors duration-200"
                >
                  {label}
                </a>
              ))}
            </nav>
          )}

          {/* Social — only render the row when at least one social link is
              configured, so empty stores don't show a hollow column. */}
          {socialLinks.length > 0 && (
            <div className={`flex items-center gap-4 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {socialLinks.map(s => (
                <a
                  key={s.key}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground overflow-hidden rounded-md transition-colors duration-200 cursor-pointer"
                  aria-label={s.key}
                >
                  <SocialGlyph entry={s} className="w-8 h-8" />
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Bottom bar removed 2026-05-21 — redundant with Company Links. */}
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce />
      </div>
    </footer>
  );
}
