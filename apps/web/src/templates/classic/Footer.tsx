'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  getDisplayBranding,
  getDisplayText,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function ClassicFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  urlPrefix = '',
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

  const socialLinks = getSocialLinks(socials);

  // Per-store footer columns take priority. Fall back to chunking the
  // navigation into up to 3 columns when no footerLinks have been saved so
  // long-standing tenants keep their existing layout.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
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
      className="bg-gray-50 dark:bg-muted/30 border-t border-border mt-auto"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4 pt-16 pb-8">
        {/* Main grid — brand + up to 4 nav columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 lg:gap-12 mb-12">
          {/* Brand column */}
          <div className="lg:col-span-2 space-y-5">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-10 max-h-10 w-auto object-contain"
              />
            ) : (
              <h3 className="text-xl font-serif font-normal text-foreground">{displayName}</h3>
            )}

            {displayDescription && (
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                {displayDescription}
              </p>
            )}

            {/* Contact details */}
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
              {displayAddress && <li>{displayAddress}</li>}
            </ul>

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
                  <h4 className="font-serif text-xs uppercase tracking-[0.2em] text-foreground mb-5">
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
                  <h4 className="font-serif text-xs uppercase tracking-[0.2em] text-foreground mb-5">
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

        {/* Divider */}
        <div className="h-px bg-border mb-6" />

        {/* Copyright bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>
            {isRtl
              ? `© ${new Date().getFullYear()} ${displayName}. جميع الحقوق محفوظة.`
              : `© ${new Date().getFullYear()} ${displayName}. All rights reserved.`}
          </p>
          <div className="flex items-center gap-5">
            <Link
              href={`${urlPrefix}/privacy`}
              className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'سياسة الخصوصية' : 'Privacy Policy'}
            </Link>
            <span aria-hidden="true">·</span>
            <Link
              href={`${urlPrefix}/terms`}
              className="hover:text-foreground transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'الشروط والأحكام' : 'Terms & Conditions'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
