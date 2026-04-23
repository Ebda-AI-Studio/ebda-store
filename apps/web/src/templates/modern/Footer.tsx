'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getDisplayBranding, getDisplayText } from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function ModernFooter({
  branding,
  contact,
  socials,
  navigation = [],
  isRtl: isRtlProp,
  urlPrefix = '',
}: FooterProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  const {
    name: displayName,
    logo: displayLogo,
    description: displayDescription,
  } = getDisplayBranding(branding, isRtl);
  const displayPhone = getDisplayText(contact.phone, contact.phoneAr, isRtl);
  const displayAddress = getDisplayText(contact.address, contact.addressAr, isRtl);

  const socialLinks = getSocialLinks(socials);

  const handleNewsletter = (e: React.FormEvent) => {
    e.preventDefault();
    setEmail('');
    setSubscribed(true);
  };

  return (
    <footer className="bg-gray-950 text-gray-300 mt-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4 py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12">
          {/* Brand Column */}
          <div className="lg:col-span-1 space-y-5">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-9 max-h-9 w-auto object-contain brightness-0 invert"
              />
            ) : (
              <h3 className="text-xl font-bold text-white">{displayName}</h3>
            )}
            {displayDescription && (
              <p className="text-gray-400 text-sm leading-relaxed">{displayDescription}</p>
            )}

            {/* Social Icons */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap gap-2.5">
                {socialLinks.map(({ key, icon, url }) => (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-9 h-9 bg-white/8 hover:bg-primary rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
                    aria-label={key}
                  >
                    <svg
                      className="w-4 h-4 text-gray-300 hover:text-white"
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

          {/* Navigation */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider">
              {isRtl ? 'الروابط' : 'Links'}
            </h4>
            <ul className="space-y-2.5">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-gray-400 hover:text-white transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider">
              {isRtl ? 'تواصل معنا' : 'Contact'}
            </h4>
            <ul className="space-y-3">
              {contact.email && (
                <li>
                  <a
                    href={`mailto:${contact.email}`}
                    className="flex items-center gap-3 text-sm text-gray-400 hover:text-white transition-colors duration-200"
                  >
                    <svg
                      className="w-4 h-4 shrink-0 text-gray-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                    {contact.email}
                  </a>
                </li>
              )}
              {displayPhone && (
                <li>
                  <a
                    href={`tel:${contact.phone}`}
                    className="flex items-center gap-3 text-sm text-gray-400 hover:text-white transition-colors duration-200"
                    dir="ltr"
                  >
                    <svg
                      className="w-4 h-4 shrink-0 text-gray-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                      />
                    </svg>
                    {displayPhone}
                  </a>
                </li>
              )}
              {contact.whatsapp && (
                <li>
                  <a
                    href={`https://wa.me/${contact.whatsapp.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 text-sm text-gray-400 hover:text-white transition-colors duration-200"
                  >
                    <svg
                      className="w-4 h-4 shrink-0 text-gray-500"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                    WhatsApp
                  </a>
                </li>
              )}
              {displayAddress && (
                <li className="flex items-start gap-3 text-sm text-gray-400">
                  <svg
                    className="w-4 h-4 mt-0.5 shrink-0 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  {displayAddress}
                </li>
              )}
            </ul>
          </div>

          {/* Newsletter */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider">
              {isRtl ? 'النشرة الإخبارية' : 'Newsletter'}
            </h4>
            <p className="text-sm text-gray-400 leading-relaxed">
              {isRtl
                ? 'اشترك للحصول على آخر العروض والأخبار'
                : 'Subscribe for the latest offers and news'}
            </p>
            {subscribed ? (
              <p className="text-sm text-primary font-medium">
                {isRtl ? 'شكراً لاشتراكك!' : 'Thank you for subscribing!'}
              </p>
            ) : (
              <form onSubmit={handleNewsletter} className="space-y-2">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder={isRtl ? 'البريد الإلكتروني' : 'Email address'}
                  aria-label={isRtl ? 'البريد الإلكتروني' : 'Email address'}
                  className="w-full px-4 py-2.5 bg-white/8 rounded-lg border border-white/10 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 text-sm text-white placeholder:text-gray-500 transition-colors duration-200"
                  dir={isRtl ? 'rtl' : 'ltr'}
                  required
                />
                <button
                  type="submit"
                  className="w-full px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors duration-200 font-semibold text-sm cursor-pointer"
                >
                  {isRtl ? 'اشتراك' : 'Subscribe'}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-6 border-t border-white/8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-gray-500">
            {isRtl
              ? `© ${new Date().getFullYear()} ${displayName}. جميع الحقوق محفوظة.`
              : `© ${new Date().getFullYear()} ${displayName}. All rights reserved.`}
          </p>
          <div className="flex items-center gap-5">
            <Link
              href={`${urlPrefix}/privacy`}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'سياسة الخصوصية' : 'Privacy Policy'}
            </Link>
            <Link
              href={`${urlPrefix}/terms`}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {isRtl ? 'الشروط والأحكام' : 'Terms & Conditions'}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
