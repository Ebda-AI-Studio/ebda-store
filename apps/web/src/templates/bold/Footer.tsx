'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';

export default function BoldFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl = false,
}: FooterProps) {
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  const displayDescription = isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  const socialLinks = [
    { key: 'instagram', label: 'IG', url: socials.instagram },
    { key: 'tiktok', label: 'TK', url: socials.tiktok },
    { key: 'twitter', label: 'X', url: socials.twitter },
    { key: 'whatsapp', label: 'WA', url: socials.whatsapp },
  ].filter(s => s.url);

  return (
    <footer className="bg-foreground text-background mt-auto relative overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-primary rounded-full blur-3xl" />
      </div>

      <div className="container mx-auto px-4 py-16 relative z-10">
        {/* Main Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 mb-16">
          {/* Brand - Big and Bold */}
          <div className="lg:col-span-2">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-12 w-auto object-contain mb-6 brightness-0 invert"
              />
            ) : (
              <h3 className="text-4xl font-black mb-6 tracking-tight">{displayName}</h3>
            )}
            {displayDescription && (
              <p className="text-background/70 text-lg max-w-md mb-8">{displayDescription}</p>
            )}

            {/* Social - Bold Labels */}
            {socialLinks.length > 0 && (
              <div className="flex gap-3">
                {socialLinks.map(({ key, label, url }) => (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-background/10 hover:bg-primary rounded-xl font-bold text-sm transition-colors"
                    aria-label={key}
                  >
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-lg font-black uppercase tracking-wider mb-6">
              {isRtl ? 'روابط سريعة' : 'Quick Links'}
            </h4>
            <ul className="space-y-3">
              {navigation.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-background/70 hover:text-primary transition-colors font-medium inline-flex items-center gap-2 group"
                  >
                    <span className="w-0 group-hover:w-4 h-0.5 bg-primary transition-all duration-300" />
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-lg font-black uppercase tracking-wider mb-6">
              {isRtl ? 'تواصل معنا' : 'Get in Touch'}
            </h4>
            <ul className="space-y-4">
              {contact.email && (
                <li>
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-background/70 hover:text-primary transition-colors font-medium"
                  >
                    {contact.email}
                  </a>
                </li>
              )}
              {displayPhone && (
                <li>
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-background/70 hover:text-primary transition-colors font-medium"
                    dir="ltr"
                  >
                    {displayPhone}
                  </a>
                </li>
              )}
              {displayAddress && (
                <li className="text-background/70">{displayAddress}</li>
              )}
            </ul>
          </div>
        </div>

        {/* Bottom Bar - Chunky */}
        <div className="pt-8 border-t border-background/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-background/50 font-medium">
            © {new Date().getFullYear()} {displayName}
          </p>
          <div className="flex gap-6">
            <Link href="/privacy" className="text-background/50 hover:text-primary transition-colors font-medium">
              {isRtl ? 'الخصوصية' : 'Privacy'}
            </Link>
            <Link href="/terms" className="text-background/50 hover:text-primary transition-colors font-medium">
              {isRtl ? 'الشروط' : 'Terms'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
