'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  getDisplayBranding,
  getDisplayText,
  resolveAddressHref,
  resolveBottomBar,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function ClassicFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  disabledCmsSlugs,
  isRtl: isRtlProp,
  urlPrefix = '',
  bgColor,
  footerLogo,
  footerLogoInvert,
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
  const bottomBar = resolveBottomBar(footerLinks?.bottomBar, displayName, isRtl, disabledCmsSlugs);
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
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} border-t border-border mt-auto`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4 pt-16 pb-8">
        {/* Main grid — brand + up to 4 nav columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 lg:gap-12 mb-12">
          {/* Brand column */}
          <div className="lg:col-span-2 space-y-5">
            {displayLogo ? (
              <img
                src={footerLogo || displayLogo}
                alt={displayName}
                className="h-16 sm:h-20 w-auto object-contain"
                style={
                  !footerLogo && footerLogoInvert
                    ? { filter: 'brightness(0) invert(1)' }
                    : undefined
                }
              />
            ) : (
              <h3 className="text-xl font-serif font-bold text-foreground">{displayName}</h3>
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

            {/* Social icons */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap gap-3 pt-1">
                {socialLinks.map(({ key, icon, url }) => (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
                    aria-label={key}
                  >
                    <svg
                      className="w-4 h-4"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d={icon} />
                    </svg>
                  </a>
                ))}
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

        {/* Bottom bar — copyright + per-store-toggleable legal links. The
            entire bar can be hidden via `footerLinks.bottomBar.enabled`. */}
        {bottomBar.enabled && (
          <>
            <div className="h-px bg-border mb-6" />
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
              <p>{bottomBar.copyright}</p>
              <div className="flex items-center gap-5">
                {bottomBar.privacyEnabled && (
                  <Link
                    href={`${urlPrefix}/privacy`}
                    className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {isRtl ? 'سياسة الخصوصية' : 'Privacy Policy'}
                  </Link>
                )}
                {bottomBar.privacyEnabled && bottomBar.termsEnabled && (
                  <span aria-hidden="true">·</span>
                )}
                {bottomBar.termsEnabled && (
                  <Link
                    href={`${urlPrefix}/terms`}
                    className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {isRtl ? 'الشروط والأحكام' : 'Terms & Conditions'}
                  </Link>
                )}
                {bottomBar.termsEnabled && bottomBar.shippingEnabled && (
                  <span aria-hidden="true">·</span>
                )}
                {bottomBar.shippingEnabled && (
                  <Link
                    href={`${urlPrefix}/shipping`}
                    className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {isRtl ? 'الشحن' : 'Shipping'}
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce />
      </div>
    </footer>
  );
}
