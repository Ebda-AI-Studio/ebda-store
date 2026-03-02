'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';

export default function ClassicFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl = false,
  urlPrefix = '',
}: FooterProps) {
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  const displayDescription =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  const socialLinks = [
    {
      key: 'instagram',
      icon: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z',
      url: socials.instagram,
    },
    {
      key: 'facebook',
      icon: 'M18.77 7.46H14.5v-1.9c0-.9.6-1.1 1-1.1h3V.5h-4.33C10.24.5 9.5 3.44 9.5 5.32v2.15h-3v4h3v12h5v-12h3.85l.42-4z',
      url: socials.facebook,
    },
    {
      key: 'twitter',
      icon: 'M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z',
      url: socials.twitter,
    },
    {
      key: 'whatsapp',
      icon: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z',
      url: socials.whatsapp,
    },
  ].filter(s => s.url);

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
