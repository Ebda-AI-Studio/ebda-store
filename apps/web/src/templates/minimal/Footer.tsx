'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';

export default function MinimalFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl = false,
  urlPrefix = '',
}: FooterProps) {
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  const allLinks = [
    ...navigation.map(item => ({
      label: isRtl && item.labelAr ? item.labelAr : item.label,
      href: item.href,
    })),
    ...(contact.email ? [{ label: contact.email, href: `mailto:${contact.email}` }] : []),
    ...(contact.phone ? [{ label: contact.phone, href: `tel:${contact.phone}` }] : []),
  ];

  // Collect active socials for a compact display
  const socialEntries = Object.entries(socials).filter(([, url]) => !!url) as [string, string][];

  return (
    <footer className="bg-background mt-auto py-12 md:py-16" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-6">
        {/* Single-row layout: logo · links · copyright */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {/* Brand */}
          <div className="flex-shrink-0">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-8 max-h-8 w-auto object-contain"
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
                  className="text-[11px] tracking-wide text-muted-foreground hover:text-foreground transition-colors duration-200"
                >
                  {label}
                </a>
              ))}
            </nav>
          )}

          {/* Social + legal */}
          <div className={`flex items-center gap-5 ${isRtl ? 'flex-row-reverse' : ''}`}>
            {socialEntries.map(([key, url]) => (
              <a
                key={key}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
                aria-label={key}
              >
                {key}
              </a>
            ))}
          </div>
        </div>

        {/* Bottom bar — copyright + legal links */}
        <div
          className={`mt-10 pt-6 border-t border-border/20 flex flex-col sm:flex-row items-center justify-between gap-3 text-[10px] text-muted-foreground ${
            isRtl ? 'flex-row-reverse' : ''
          }`}
        >
          <p>
            © {new Date().getFullYear()} {displayName}
          </p>
          <div className={`flex items-center gap-5 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Link
              href={`${urlPrefix}/privacy`}
              className="hover:text-foreground transition-colors duration-200"
            >
              {isRtl ? 'الخصوصية' : 'Privacy'}
            </Link>
            <Link
              href={`${urlPrefix}/terms`}
              className="hover:text-foreground transition-colors duration-200"
            >
              {isRtl ? 'الشروط' : 'Terms'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
