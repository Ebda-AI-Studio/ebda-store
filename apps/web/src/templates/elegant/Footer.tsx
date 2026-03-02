'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';

export default function ElegantFooter({
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
  ].filter(s => s.url);

  return (
    <footer className="bg-muted/20 border-t border-border/30 mt-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Newsletter Section */}
      <div className="border-b border-border/30">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-xl mx-auto text-center">
            <h3 className="text-sm tracking-[0.3em] uppercase text-muted-foreground mb-4">
              {isRtl ? 'ابق على اطلاع' : 'Stay Informed'}
            </h3>
            <p className="text-foreground font-light text-lg mb-8">
              {isRtl
                ? 'اشترك لتصلك آخر الأخبار والعروض الحصرية'
                : 'Subscribe for exclusive offers and new arrivals'}
            </p>
            <form className="flex gap-0 max-w-md mx-auto">
              <input
                type="email"
                placeholder={isRtl ? 'البريد الإلكتروني' : 'Enter your email'}
                className="flex-1 px-6 py-4 bg-background border border-border focus:border-foreground focus:outline-none text-sm placeholder:text-muted-foreground"
                dir={isRtl ? 'rtl' : 'ltr'}
              />
              <button
                type="submit"
                className="px-8 py-4 bg-primary text-primary-foreground text-sm tracking-[0.2em] uppercase hover:bg-primary/90 transition-colors"
              >
                {isRtl ? 'اشتراك' : 'Subscribe'}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Main Footer */}
      <div className="container mx-auto px-4 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-10 max-h-10 w-auto object-contain mb-6"
              />
            ) : (
              <h3 className="text-lg font-light tracking-wide text-foreground mb-6">
                {displayName}
              </h3>
            )}
            {displayDescription && (
              <p className="text-sm text-muted-foreground leading-relaxed">{displayDescription}</p>
            )}
          </div>

          {/* Navigation */}
          <div>
            <h4 className="text-xs tracking-[0.2em] uppercase text-muted-foreground mb-6">
              {isRtl ? 'التصفح' : 'Explore'}
            </h4>
            <ul className="space-y-3">
              {navigation.slice(0, 5).map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-foreground/70 hover:text-foreground transition-colors"
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-xs tracking-[0.2em] uppercase text-muted-foreground mb-6">
              {isRtl ? 'تواصل' : 'Contact'}
            </h4>
            <ul className="space-y-3 text-sm">
              {contact.email && (
                <li>
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-foreground/70 hover:text-foreground transition-colors"
                  >
                    {contact.email}
                  </a>
                </li>
              )}
              {displayPhone && (
                <li>
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-foreground/70 hover:text-foreground transition-colors"
                    dir="ltr"
                  >
                    {displayPhone}
                  </a>
                </li>
              )}
              {displayAddress && <li className="text-foreground/70">{displayAddress}</li>}
            </ul>
          </div>

          {/* Social */}
          <div>
            <h4 className="text-xs tracking-[0.2em] uppercase text-muted-foreground mb-6">
              {isRtl ? 'تابعنا' : 'Follow'}
            </h4>
            <div className="flex gap-4">
              {socialLinks.map(({ key, icon, url }) => (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-10 h-10 border border-border flex items-center justify-center text-foreground/70 hover:border-foreground hover:text-foreground transition-colors"
                  aria-label={key}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d={icon} />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-border/30">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
            <p>
              © {new Date().getFullYear()} {displayName}.{' '}
              {isRtl ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}
            </p>
            <div className="flex gap-6">
              <Link
                href={`${urlPrefix}/privacy`}
                className="hover:text-foreground transition-colors"
              >
                {isRtl ? 'الخصوصية' : 'Privacy'}
              </Link>
              <Link href={`${urlPrefix}/terms`} className="hover:text-foreground transition-colors">
                {isRtl ? 'الشروط' : 'Terms'}
              </Link>
              <Link
                href={`${urlPrefix}/shipping`}
                className="hover:text-foreground transition-colors"
              >
                {isRtl ? 'الشحن' : 'Shipping'}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
