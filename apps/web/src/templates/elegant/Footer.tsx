'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { isNewsletterEnabled, resolveFooterSections } from '../shared/display-helpers';
import { getSocialLinks } from '../shared/icons';

export default function ElegantFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  urlPrefix = '',
}: FooterProps) {
  const { isRtl: ctxIsRtl, language } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  const displayDescription =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  const socialLinks = getSocialLinks(socials);
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Real signup wired to /public/newsletter/subscribe. The Elegant template
  // never had local form state for the email — adding it here so we can
  // forward the value and clear it on success.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const result = await api.subscribeNewsletter({
        email: email.trim(),
        language,
        source: 'footer',
      });
      if (result.success) {
        setSubscribed(true);
        setEmail('');
      } else {
        setErrorMsg(isRtl ? 'تعذر الاشتراك، حاول لاحقاً' : 'Could not subscribe, please try again');
      }
    } catch {
      setErrorMsg(isRtl ? 'تعذر الاشتراك، حاول لاحقاً' : 'Could not subscribe, please try again');
    } finally {
      setSubmitting(false);
    }
  };
  // Per-store footer columns replace the single "Explore" column when at
  // least one section has active links. With nothing configured we render
  // the pack's classic Explore / Contact / Follow trio.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
  const showNewsletter = isNewsletterEnabled(footerLinks);

  return (
    <footer className="bg-muted border-t border-border mt-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Newsletter — hidden when the store explicitly opts out. */}
      {showNewsletter && (
        <div className="border-b border-border/50">
          <div className="container mx-auto px-4 py-10 sm:py-12 md:py-16">
            <div className="max-w-xl mx-auto text-center">
              <h3 className="text-xs tracking-[0.3em] uppercase text-muted-foreground/70 mb-4 font-serif">
                {isRtl ? 'ابق على اطلاع' : 'Stay Informed'}
              </h3>
              <p className="text-foreground font-light text-lg sm:text-xl mb-8 tracking-wide leading-relaxed">
                {isRtl
                  ? 'اشترك لتصلك آخر الأخبار والعروض الحصرية'
                  : 'Subscribe for exclusive offers and new arrivals'}
              </p>
              {subscribed ? (
                <p className="text-sm text-primary font-medium tracking-wide">
                  {isRtl ? 'شكراً لاشتراكك!' : 'Thank you for subscribing!'}
                </p>
              ) : (
                <>
                  <form
                    className="flex flex-col gap-2 sm:flex-row sm:gap-0 max-w-md mx-auto"
                    onSubmit={handleSubmit}
                  >
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder={isRtl ? 'البريد الإلكتروني' : 'Enter your email'}
                      aria-label={isRtl ? 'البريد الإلكتروني' : 'Email address'}
                      className="h-12 flex-1 px-6 bg-background border border-border focus:border-foreground focus:outline-none text-sm tracking-wide placeholder:text-muted-foreground/50 transition-colors duration-500"
                      dir={isRtl ? 'rtl' : 'ltr'}
                      required
                      disabled={submitting}
                    />
                    <button
                      type="submit"
                      disabled={submitting}
                      className="h-12 px-8 bg-foreground text-background text-xs tracking-[0.2em] uppercase hover:bg-foreground/80 transition-colors duration-300 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {submitting
                        ? isRtl
                          ? 'جاري...'
                          : 'Sending...'
                        : isRtl
                          ? 'اشتراك'
                          : 'Subscribe'}
                    </button>
                  </form>
                  {errorMsg && (
                    <p className="mt-3 text-[10px] tracking-wide text-destructive" role="alert">
                      {errorMsg}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main footer */}
      <div className="container mx-auto px-4 py-10 sm:py-12 md:py-16">
        {/* Brand + (sections|explore) + Contact + Follow. Grow the grid so
            extra sections don't crowd the contact / follow columns. */}
        <div
          className={`grid grid-cols-2 gap-8 sm:gap-10 ${
            footerSections.length >= 3
              ? 'md:grid-cols-6'
              : footerSections.length === 2
                ? 'md:grid-cols-5'
                : 'md:grid-cols-4'
          } md:gap-12`}
        >
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="h-10 max-h-10 w-auto object-contain mb-6"
              />
            ) : (
              <h3 className="text-base font-light tracking-[0.2em] text-foreground mb-6 font-serif">
                {displayName}
              </h3>
            )}
            {displayDescription && (
              <p className="text-sm text-muted-foreground leading-loose tracking-wide">
                {displayDescription}
              </p>
            )}
          </div>

          {/* Navigation — per-store sections when configured, otherwise the
              single "Explore" column driven by the navigation prop. */}
          {footerSections.length > 0 ? (
            footerSections.map(section => (
              <div key={section.key}>
                <h4 className="text-xs tracking-[0.25em] uppercase text-foreground/70 mb-6 font-serif">
                  {section.heading}
                </h4>
                <ul className="space-y-4">
                  {section.links.map(link => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-sm text-foreground/70 hover:text-foreground transition-opacity duration-300 tracking-wide cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div>
              <h4 className="text-xs tracking-[0.25em] uppercase text-foreground/70 mb-6 font-serif">
                {isRtl ? 'التصفح' : 'Explore'}
              </h4>
              <ul className="space-y-4">
                {navigation.slice(0, 5).map(item => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-sm text-foreground/70 hover:text-foreground transition-opacity duration-300 tracking-wide cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      {isRtl && item.labelAr ? item.labelAr : item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Contact — hidden entirely if the store has no contact details
              configured. Empty heading + empty list looks unfinished. */}
          {(contact.email || displayPhone || displayAddress) && (
            <div>
              <h4 className="text-xs tracking-[0.25em] uppercase text-foreground/70 mb-6 font-serif">
                {isRtl ? 'تواصل' : 'Contact'}
              </h4>
              <ul className="space-y-4 text-sm">
                {contact.email && (
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className="text-foreground/70 hover:text-foreground transition-opacity duration-300 tracking-wide cursor-pointer"
                    >
                      {contact.email}
                    </a>
                  </li>
                )}
                {displayPhone && (
                  <li>
                    <a
                      href={`tel:${contact.phone}`}
                      className="text-foreground/70 hover:text-foreground transition-opacity duration-300 tracking-wide cursor-pointer"
                      dir="ltr"
                    >
                      {displayPhone}
                    </a>
                  </li>
                )}
                {displayAddress && (
                  <li className="text-foreground/70 leading-loose">{displayAddress}</li>
                )}
              </ul>
            </div>
          )}

          {/* Social — hidden when there are no social links configured. */}
          {socialLinks.length > 0 && (
            <div>
              <h4 className="text-xs tracking-[0.25em] uppercase text-foreground/70 mb-6 font-serif">
                {isRtl ? 'تابعنا' : 'Follow'}
              </h4>
              <div className="flex flex-wrap gap-3">
                {socialLinks.map(({ key, icon, url }) => (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-8 h-8 border border-border flex items-center justify-center text-foreground/40 hover:text-foreground hover:border-foreground transition-all duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    aria-label={key}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d={icon} />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-border/50">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-xs tracking-wide text-muted-foreground/70">
            <p>
              © {new Date().getFullYear()} {displayName}.{' '}
              {isRtl ? 'جميع الحقوق محفوظة.' : 'All rights reserved.'}
            </p>
            <div className="flex gap-6">
              <Link
                href={`${urlPrefix}/privacy`}
                className="hover:text-foreground transition-opacity duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {isRtl ? 'الخصوصية' : 'Privacy'}
              </Link>
              <Link
                href={`${urlPrefix}/terms`}
                className="hover:text-foreground transition-opacity duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {isRtl ? 'الشروط' : 'Terms'}
              </Link>
              <Link
                href={`${urlPrefix}/shipping`}
                className="hover:text-foreground transition-opacity duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
