'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';
import { getDisplayBranding, getDisplayText } from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function ClassicFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl = false,
  urlPrefix = '',
}: FooterProps) {
  const {
    name: displayName,
    logo: displayLogo,
    description: displayDescription,
  } = getDisplayBranding(branding, isRtl);
  const displayPhone = getDisplayText(contact.phone, contact.phoneAr, isRtl);
  const displayAddress = getDisplayText(contact.address, contact.addressAr, isRtl);

  const socialLinks = getSocialLinks(socials);

  return (
    <footer className="bg-muted/30 border-t border-border mt-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top Decorative Border */}
      <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      <div className="container mx-auto px-4 py-16">
        {/* Main Content - Centered elegant layout */}
        <div className="max-w-4xl mx-auto text-center mb-12">
          {/* Logo/Name */}
          <div className="mb-8">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-10 max-h-10 w-auto object-contain mx-auto"
              />
            ) : (
              <h3 className="text-2xl font-serif font-normal text-foreground">{displayName}</h3>
            )}
          </div>

          {/* Description */}
          {displayDescription && (
            <p className="text-muted-foreground max-w-md mx-auto mb-8 leading-relaxed">
              {displayDescription}
            </p>
          )}

          {/* Navigation - Horizontal centered */}
          {navigation.length > 0 && (
            <nav className="flex flex-wrap justify-center gap-x-8 gap-y-3 mb-8">
              {navigation.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors tracking-wide"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                </Link>
              ))}
            </nav>
          )}

          {/* Social Links */}
          {socialLinks.length > 0 && (
            <div className="flex justify-center gap-6 mb-8">
              {socialLinks.map(({ key, icon, url }) => (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  aria-label={key}
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d={icon} />
                  </svg>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Contact Grid */}
        <div className="grid md:grid-cols-3 gap-8 max-w-3xl mx-auto text-center border-t border-border/50 pt-12 mb-12">
          {/* Email */}
          {contact.email && (
            <div>
              <h4 className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-3">
                {isRtl ? 'البريد الإلكتروني' : 'Email'}
              </h4>
              <a
                href={`mailto:${contact.email}`}
                className="text-foreground hover:text-primary transition-colors"
              >
                {contact.email}
              </a>
            </div>
          )}

          {/* Phone */}
          {displayPhone && (
            <div>
              <h4 className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-3">
                {isRtl ? 'الهاتف' : 'Phone'}
              </h4>
              <a
                href={`tel:${contact.phone}`}
                className="text-foreground hover:text-primary transition-colors"
                dir="ltr"
              >
                {displayPhone}
              </a>
            </div>
          )}

          {/* Address */}
          {displayAddress && (
            <div>
              <h4 className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-3">
                {isRtl ? 'العنوان' : 'Address'}
              </h4>
              <p className="text-foreground">{displayAddress}</p>
            </div>
          )}
        </div>

        {/* Bottom Bar */}
        <div className="text-center pt-8 border-t border-border/30">
          <p className="text-sm text-muted-foreground">
            {isRtl
              ? `© ${new Date().getFullYear()} ${displayName}. جميع الحقوق محفوظة.`
              : `© ${new Date().getFullYear()} ${displayName}. All rights reserved.`}
          </p>
          <div className="flex justify-center gap-6 mt-4 text-xs text-muted-foreground">
            <Link href={`${urlPrefix}/privacy`} className="hover:text-foreground transition-colors">
              {isRtl ? 'سياسة الخصوصية' : 'Privacy Policy'}
            </Link>
            <span>·</span>
            <Link href={`${urlPrefix}/terms`} className="hover:text-foreground transition-colors">
              {isRtl ? 'الشروط والأحكام' : 'Terms & Conditions'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
