'use client';

import Link from 'next/link';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getSocialLinks } from '../shared/icons';

export default function BoldFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl: isRtlProp,
  urlPrefix = '',
}: FooterProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  const displayDescription =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  const socialLinks = getSocialLinks(socials);

  return (
    <footer className="bg-gray-950 text-white mt-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4 py-10 sm:py-12 md:py-16">
        {/* Main grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 sm:gap-10 md:gap-12 mb-10 sm:mb-12 md:mb-16">
          {/* Brand */}
          <div className="lg:col-span-2">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-10 max-h-10 w-auto object-contain mb-6 brightness-0 invert"
              />
            ) : (
              <h3 className="text-3xl font-black uppercase tracking-wider mb-6 text-white">
                {displayName}
              </h3>
            )}
            {displayDescription && (
              <p className="text-gray-300 text-sm leading-relaxed max-w-sm mb-8">
                {displayDescription}
              </p>
            )}

            {/* Social icons — bright accent on hover */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {socialLinks.map(({ key, icon, url }) => (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-primary rounded-lg transition-colors duration-200 cursor-pointer"
                    aria-label={key}
                  >
                    <svg
                      className="w-4 h-4 text-white"
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

          {/* Quick Links */}
          <div>
            <h4 className="text-xs font-black uppercase tracking-[0.2em] mb-6 text-white">
              {isRtl ? 'روابط سريعة' : 'Quick Links'}
            </h4>
            <ul className="space-y-3">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-gray-300 hover:text-primary transition-colors duration-200 font-medium inline-flex items-center gap-2 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    <span className="w-0 group-hover:w-3 h-0.5 bg-primary transition-all duration-200 shrink-0" />
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-xs font-black uppercase tracking-[0.2em] mb-6 text-white">
              {isRtl ? 'تواصل معنا' : 'Get in Touch'}
            </h4>
            <ul className="space-y-3">
              {contact.email && (
                <li>
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-sm text-gray-300 hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {contact.email}
                  </a>
                </li>
              )}
              {displayPhone && (
                <li>
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-sm text-gray-300 hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    dir="ltr"
                  >
                    {displayPhone}
                  </a>
                </li>
              )}
              {displayAddress && <li className="text-sm text-gray-300">{displayAddress}</li>}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-gray-400 font-medium">
            © {new Date().getFullYear()} {displayName}
          </p>
          <div className="flex gap-6">
            <Link
              href={`${urlPrefix}/privacy`}
              className="text-xs text-gray-400 hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'الخصوصية' : 'Privacy'}
            </Link>
            <Link
              href={`${urlPrefix}/terms`}
              className="text-xs text-gray-400 hover:text-primary transition-colors duration-200 font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'الشروط' : 'Terms'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
