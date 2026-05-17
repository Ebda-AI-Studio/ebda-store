'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { resolveBottomBar, resolveFooterSections } from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function MinimalFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  disabledCmsSlugs,
  isRtl: isRtlProp,
  urlPrefix = '',
}: FooterProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

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

  const bottomBar = resolveBottomBar(footerLinks?.bottomBar, displayName, isRtl, disabledCmsSlugs);

  return (
    <footer
      className="bg-[hsl(var(--bg-section-alt))] mt-auto py-12 md:py-16"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-6">
        {/* Single-row layout: logo · links · copyright */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {/* Brand */}
          <div className="flex-shrink-0">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-16 sm:h-20 w-auto object-contain"
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
              configured, so empty stores don't show a hollow column. Uses the
              shared brand-correct SVG icons rather than text labels so the
              footer doesn't read as half-finished placeholder copy. */}
          {socialLinks.length > 0 && (
            <div className={`flex items-center gap-4 ${isRtl ? 'flex-row-reverse' : ''}`}>
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

        {/* Bottom bar — copyright + per-store-toggleable legal links. The
            entire bar can be hidden via `footerLinks.bottomBar.enabled`. */}
        {bottomBar.enabled && (
          <div
            className={`mt-10 pt-6 border-t border-border/20 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground ${
              isRtl ? 'flex-row-reverse' : ''
            }`}
          >
            <p>{bottomBar.copyright}</p>
            <div className={`flex items-center gap-5 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {bottomBar.privacyEnabled && (
                <Link
                  href={`${urlPrefix}/privacy`}
                  className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {isRtl ? 'الخصوصية' : 'Privacy'}
                </Link>
              )}
              {bottomBar.termsEnabled && (
                <Link
                  href={`${urlPrefix}/terms`}
                  className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {isRtl ? 'الشروط' : 'Terms'}
                </Link>
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
        )}
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce />
      </div>
    </footer>
  );
}
