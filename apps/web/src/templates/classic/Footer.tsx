'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  getDisplayBranding,
  getDisplayText,
  resolveAddressHref,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';

export default function ClassicFooter({
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
  const {
    name: displayName,
    logo: displayLogo,
    description: displayDescription,
  } = getDisplayBranding(branding, isRtl);
  const displayPhone = getDisplayText(contact.phone, contact.phoneAr, isRtl);
  const displayAddress = getDisplayText(contact.address, contact.addressAr, isRtl);

  // Pass `contact` so the WhatsApp icon appears in the social row when only
  // the merchant's WhatsApp phone is set (no full URL in `socials`).
  const socialLinks = getSocialLinks(socials, contact);

  // Per-store footer columns take priority. Fall back to chunking the
  // navigation into up to 3 columns when no footerLinks have been saved so
  // long-standing tenants keep their existing layout.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
  const addressMapHref = resolveAddressHref(
    displayAddress,
    contact.addressUrl,
    contact.addressLink
  );
  const useDefaultNavChunks = footerSections.length === 0;
  const navChunks: (typeof navigation)[] = [];
  if (useDefaultNavChunks && navigation.length > 0) {
    const chunkSize = Math.ceil(navigation.length / 3);
    for (let i = 0; i < navigation.length; i += chunkSize) {
      navChunks.push(navigation.slice(i, i + chunkSize));
    }
  }

  return (
    <footer
      data-zone="footer"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} border-t border-border mt-auto`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4 pt-16 pb-8">
        {/* Main grid — brand + up to 4 nav columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 lg:gap-12 mb-12">
          {/* Brand column — logo desktop-only at top; on mobile it
              moves beside the social icons below (Ahmad 2026-05-21). */}
          <div className="lg:col-span-2 space-y-5">
            {displayLogo ? (
              <img
                src={footerLogo || displayLogo}
                alt={displayName}
                className="hidden md:block h-16 sm:h-20 w-auto object-contain"
                style={
                  !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                    ? { filter: footerLogoAutoFilter }
                    : undefined
                }
              />
            ) : (
              <h3 className="hidden md:block text-xl font-serif font-bold text-foreground">
                {displayName}
              </h3>
            )}

            {displayDescription && (
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                {displayDescription}
              </p>
            )}

            {/* Contact details — only render the list if at least one
                detail is present. Classic mixes contact into the brand
                column so an empty <ul> would create dead space. */}
            {(contact.email || displayPhone || displayAddress) && (
              <ul className="space-y-2 text-sm text-muted-foreground">
                {contact.email && (
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className="hover:text-foreground transition-colors duration-200"
                    >
                      {contact.email}
                    </a>
                  </li>
                )}
                {displayPhone && (
                  <li>
                    <a
                      href={`tel:${contact.phone}`}
                      className="hover:text-foreground transition-colors duration-200"
                      dir="ltr"
                    >
                      {displayPhone}
                    </a>
                  </li>
                )}
                {displayAddress && (
                  <li>
                    {addressMapHref ? (
                      <a
                        href={addressMapHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-foreground transition-colors duration-200"
                      >
                        {displayAddress}
                      </a>
                    ) : (
                      displayAddress
                    )}
                  </li>
                )}
              </ul>
            )}

            {/* Social icons — on mobile, the logo lands at the OPPOSITE end
                of this row via ms-auto. Ahmad 2026-05-21. */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
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
                {displayLogo && !hideFooterLogoMobile && (
                  <img
                    src={footerLogo || displayLogo}
                    alt={displayName}
                    className="md:hidden ms-auto h-16 w-auto object-contain"
                    style={
                      !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                        ? { filter: footerLogoAutoFilter }
                        : undefined
                    }
                  />
                )}
              </div>
            )}
          </div>

          {/* Navigation columns — per-store sections when configured, else
              chunked navigation as before. */}
          {footerSections.length > 0
            ? footerSections.map(section => (
                <div key={section.key}>
                  <h4 className="font-serif font-bold text-xs uppercase tracking-[0.2em] text-foreground mb-5">
                    {section.heading}
                  </h4>
                  <ul className="space-y-3">
                    {section.links.map(link => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className="text-sm text-muted-foreground hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            : navChunks.map((chunk, ci) => (
                <div key={ci}>
                  <h4 className="font-serif font-bold text-xs uppercase tracking-[0.2em] text-foreground mb-5">
                    {ci === 0
                      ? isRtl
                        ? 'روابط'
                        : 'Links'
                      : ci === 1
                        ? isRtl
                          ? 'تسوق'
                          : 'Shop'
                        : ci === 2
                          ? isRtl
                            ? 'مساعدة'
                            : 'Help'
                          : isRtl
                            ? 'المزيد'
                            : 'More'}
                  </h4>
                  <ul className="space-y-3">
                    {chunk.map(item => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="text-sm text-muted-foreground hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          {isRtl && item.labelAr ? item.labelAr : item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
        </div>

        {/* Bottom bar removed 2026-05-21 — redundant with Company Links. */}
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce />
      </div>
    </footer>
  );
}
