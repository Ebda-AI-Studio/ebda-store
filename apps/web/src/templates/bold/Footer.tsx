'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { resolveAddressHref, resolveFooterSections } from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';

export default function BoldFooter({
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
  theme,
}: FooterProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = footerLogo || (isRtl && branding.logoAr ? branding.logoAr : branding.logo);
  const displayDescription =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  // Pass `contact` so a stored WhatsApp phone produces a wa.me icon in the
  // social row even when `socials.whatsapp` is empty.
  const socialLinks = getSocialLinks(socials, contact, theme?.socialOrder);
  // Per-store columns replace the single "Quick Links" block; with nothing
  // configured we keep the navigation-driven default below. Bold has no
  // newsletter form so newsletterEnabled does not apply here.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
  const addressMapHref = resolveAddressHref(
    displayAddress,
    contact.addressUrl,
    contact.addressLink
  );

  // Hide the contact column entirely when the store has no contact details
  // configured — empty heading + empty list reads as half-built.
  const hasContact = !!(contact.email || displayPhone || displayAddress);

  // Brand always spans 2 cols. With sections (1 fallback or N footerSections)
  // + (contact?), total cells = 2 + N + (hasContact ? 1 : 0).
  const linkColumnsCount = footerSections.length > 0 ? footerSections.length : 1;
  const totalCells = 2 + linkColumnsCount + (hasContact ? 1 : 0);
  const lgColsClass =
    totalCells >= 6 ? 'lg:grid-cols-6' : totalCells === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4';

  // Item 2 (2026-07-12) persona-completion: bold's inverted footer
  // (design.md "inverted footer — accent is the only color on the bar").
  // Only auto-inverts when the merchant hasn't picked a custom bgColor —
  // an explicit merchant color pick always wins over the persona default.
  // Uses only the existing --foreground/--background tokens (swapped
  // roles), never a new color.
  const invertFooter = theme?.personaChromeV2 === true && !bgColor;
  const fgFull = invertFooter ? 'text-background' : 'text-foreground';
  const fgMuted = invertFooter ? 'text-background/75' : 'text-foreground/75';

  return (
    <footer
      data-zone="footer"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : invertFooter ? 'bg-foreground' : 'bg-[hsl(var(--bg-section-alt))]'} ${fgFull} mt-auto`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4 py-12 sm:py-16 md:py-20">
        {/* Main grid */}
        <div
          className={`grid md:grid-cols-2 ${lgColsClass} gap-8 sm:gap-10 md:gap-12 mb-10 sm:mb-12 md:mb-16`}
        >
          {/* Brand — logo centered at top on mobile (Ahmad 2026-06-20). */}
          <div className="lg:col-span-2">
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
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="hidden md:block h-16 sm:h-20 w-auto object-contain mb-6"
                style={
                  !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                    ? { filter: footerLogoAutoFilter }
                    : undefined
                }
              />
            ) : (
              <h3
                className={`hidden md:block text-3xl font-black ui-caps-toggle tracking-wider mb-6 ${fgFull}`}
              >
                {displayName}
              </h3>
            )}
            {displayDescription && (
              <p className={`${fgMuted} text-sm leading-relaxed max-w-sm mb-8`}>
                {displayDescription}
              </p>
            )}

            {/* Social icons */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                {socialLinks.map(s => (
                  <a
                    key={s.key}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${fgFull} hover:text-primary transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
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
          </div>

          {/* Quick Links — per-store columns when configured, else the
              navigation-driven default. */}
          {footerSections.length > 0 ? (
            footerSections.map(section => (
              <div key={section.key}>
                <h4 className={`text-xs font-black ui-caps-toggle tracking-[0.2em] mb-6 ${fgFull}`}>
                  {section.heading}
                </h4>
                <ul className="space-y-3">
                  {section.links.map(link => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className={`text-sm ${fgMuted} hover:text-primary transition-colors duration-200 font-medium inline-flex items-center gap-2 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
                      >
                        <span className="w-0 group-hover:w-3 h-0.5 bg-primary transition-[width] duration-200 shrink-0" />
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div>
              <h4 className={`text-xs font-black ui-caps-toggle tracking-[0.2em] mb-6 ${fgFull}`}>
                {isRtl ? 'روابط سريعة' : 'Quick Links'}
              </h4>
              <ul className="space-y-3">
                {navigation.map(item => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`text-sm ${fgMuted} hover:text-primary transition-colors duration-200 font-medium inline-flex items-center gap-2 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
                    >
                      <span className="w-0 group-hover:w-3 h-0.5 bg-primary transition-[width] duration-200 shrink-0" />
                      {isRtl && item.labelAr ? item.labelAr : item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Contact — gated on hasContact so empty stores don't show a
              hollow column. */}
          {hasContact && (
            <div>
              <h4 className={`text-xs font-black ui-caps-toggle tracking-[0.2em] mb-6 ${fgFull}`}>
                {isRtl ? 'تواصل معنا' : 'Get in Touch'}
              </h4>
              <ul className="space-y-3">
                {contact.email && (
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className={`text-sm ${fgMuted} hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
                    >
                      {contact.email}
                    </a>
                  </li>
                )}
                {displayPhone && (
                  <li>
                    <a
                      href={`tel:${contact.phone}`}
                      className={`text-sm ${fgMuted} hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
                      dir="ltr"
                    >
                      {displayPhone}
                    </a>
                  </li>
                )}
                {displayAddress && (
                  <li className={`text-sm ${fgMuted}`}>
                    {addressMapHref ? (
                      <a
                        href={addressMapHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary transition-colors duration-200"
                      >
                        {displayAddress}
                      </a>
                    ) : (
                      displayAddress
                    )}
                  </li>
                )}
              </ul>
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
