'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import { useState } from 'react';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import {
  getDisplayBranding,
  getDisplayText,
  isNewsletterEnabled,
  resolveAddressHref,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';

export default function ModernFooter({
  branding,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  bgColor,
  footerLogo,
  footerLogoInvert,
  hideFooterLogoMobile,
}: FooterProps) {
  const { isRtl: ctxIsRtl, language } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const {
    name: displayName,
    logo: displayLogo,
    description: displayDescription,
  } = getDisplayBranding(branding, isRtl);
  const displayPhone = getDisplayText(contact.phone, contact.phoneAr, isRtl);
  const displayAddress = getDisplayText(contact.address, contact.addressAr, isRtl);

  // Pass `contact` so a merchant who saved a WhatsApp phone (without a full
  // wa.me URL in socials) still gets a proper WhatsApp icon in the row.
  const socialLinks = getSocialLinks(socials, contact);
  // Per-store footer columns (shop / company / support) replace the single
  // "Links" column when the owner has configured at least one section. With
  // an empty config we fall back to the navigation-driven default below.
  const footerSections = resolveFooterSections(footerLinks, isRtl);
  const showNewsletter = isNewsletterEnabled(footerLinks);
  const addressMapHref = resolveAddressHref(
    displayAddress,
    contact.addressUrl,
    contact.addressLink
  );

  // Real signup wired to /public/newsletter/subscribe. We tag the source
  // so admin analytics can tell apart footer signups from any future popup.
  const handleNewsletter = async (e: React.FormEvent) => {
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

  // Brand + sections (1 fallback col, or N footerSections) + (contact?) + (newsletter?).
  // We omit columns the store hasn't populated so the grid stays balanced.
  // WhatsApp is excluded from the trigger because it appears in the social
  // icon row above — repeating it under "Contact" is the duplication this
  // pass cleans up.
  const hasContact = !!(contact.email || displayPhone || displayAddress);
  const linkColumnsCount = footerSections.length > 0 ? footerSections.length : 1;
  const totalColumns = 1 + linkColumnsCount + (hasContact ? 1 : 0) + (showNewsletter ? 1 : 0);
  const lgColsClass =
    totalColumns >= 6
      ? 'lg:grid-cols-6'
      : totalColumns === 5
        ? 'lg:grid-cols-5'
        : totalColumns === 4
          ? 'lg:grid-cols-4'
          : 'lg:grid-cols-3';

  return (
    <footer
      data-zone="footer"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} text-foreground/75 mt-auto`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4 py-16 lg:py-20">
        <div className={`grid grid-cols-1 md:grid-cols-2 ${lgColsClass} gap-10 lg:gap-12`}>
          {/* Brand Column — logo desktop-only at top; on mobile it
              moves beside the social icons below (Ahmad 2026-05-21). */}
          <div className="lg:col-span-1 space-y-5">
            {displayLogo ? (
              <img
                src={footerLogo || displayLogo}
                alt={displayName}
                className="hidden md:block h-16 sm:h-20 w-auto object-contain"
                style={
                  !footerLogo && footerLogoInvert
                    ? { filter: 'brightness(0) invert(1)' }
                    : undefined
                }
              />
            ) : (
              <h3 className="hidden md:block text-xl font-bold text-foreground">{displayName}</h3>
            )}
            {displayDescription && (
              <p className="text-foreground/60 text-sm leading-relaxed">{displayDescription}</p>
            )}

            {/* Social Icons — on mobile, the logo lands at the OPPOSITE end
                of this row (ms-auto). Ahmad 2026-05-21: bigger + on the
                other side from "follow us" cluster. */}
            {socialLinks.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                {socialLinks.map(s => (
                  <a
                    key={s.key}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground/75 hover:text-foreground transition-colors duration-300 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    aria-label={s.key}
                  >
                    <SocialGlyph entry={s} className="w-8 h-8" />
                  </a>
                ))}
                {displayLogo && !hideFooterLogoMobile && (
                  <img
                    src={footerLogo || displayLogo}
                    alt={displayName}
                    className="md:hidden ms-auto h-16 w-auto object-contain"
                    style={
                      !footerLogo && footerLogoInvert
                        ? { filter: 'brightness(0) invert(1)' }
                        : undefined
                    }
                  />
                )}
              </div>
            )}
          </div>

          {/* Navigation — per-store footerLinks columns when configured, else
              fall back to the single navigation-driven column. */}
          {footerSections.length > 0 ? (
            footerSections.map(section => (
              <div key={section.key} className="space-y-4">
                <h4 className="text-xs font-bold text-foreground uppercase tracking-[0.18em]">
                  {section.heading}
                </h4>
                <ul className="space-y-2.5">
                  {section.links.map(link => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-sm text-foreground/60 hover:text-foreground transition-colors duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-foreground uppercase tracking-[0.18em]">
                {isRtl ? 'الروابط' : 'Links'}
              </h4>
              <ul className="space-y-2.5">
                {navigation.map(item => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-sm text-foreground/60 hover:text-foreground transition-colors duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      {isRtl && item.labelAr ? item.labelAr : item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Contact — hidden when no contact details are configured.
              Empty section with just a heading looks unfinished. */}
          {hasContact && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-foreground uppercase tracking-[0.18em]">
                {isRtl ? 'تواصل معنا' : 'Contact'}
              </h4>
              <ul className="space-y-3">
                {contact.email && (
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className="flex items-center gap-3 text-sm text-foreground/60 hover:text-foreground transition-colors duration-300 ease-out"
                    >
                      <svg
                        className="w-4 h-4 shrink-0 text-foreground/55"
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
                      className="flex items-center gap-3 text-sm text-foreground/60 hover:text-foreground transition-colors duration-300 ease-out"
                      dir="ltr"
                    >
                      <svg
                        className="w-4 h-4 shrink-0 text-foreground/55"
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
                {/* WhatsApp lives in the social row at the brand block; we
                    don't repeat it here to avoid duplicating the same link. */}
                {displayAddress &&
                  (() => {
                    const mapIcon = (
                      <svg
                        className="w-4 h-4 mt-0.5 shrink-0 text-foreground/55"
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
                    );
                    return addressMapHref ? (
                      <li>
                        <a
                          href={addressMapHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start gap-3 text-sm text-foreground/60 hover:text-foreground transition-colors duration-300 ease-out"
                        >
                          {mapIcon}
                          {displayAddress}
                        </a>
                      </li>
                    ) : (
                      <li className="flex items-start gap-3 text-sm text-foreground/60">
                        {mapIcon}
                        {displayAddress}
                      </li>
                    );
                  })()}
              </ul>
            </div>
          )}

          {/* Newsletter — hidden when the store explicitly opts out. */}
          {showNewsletter && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-foreground uppercase tracking-[0.18em]">
                {isRtl ? 'النشرة الإخبارية' : 'Newsletter'}
              </h4>
              {/* Body line — render store description when set; previously
                  was hardcoded demo copy. */}
              {displayDescription && (
                <p className="text-sm text-foreground/60 leading-relaxed">{displayDescription}</p>
              )}
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
                    className="w-full px-4 py-2.5 bg-foreground/10 rounded-lg border border-white/10 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 text-sm text-foreground placeholder:text-foreground/55 transition-colors duration-300 ease-out"
                    dir={isRtl ? 'rtl' : 'ltr'}
                    required
                    disabled={submitting}
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors duration-300 ease-out font-semibold text-sm cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitting
                      ? isRtl
                        ? 'جاري الاشتراك...'
                        : 'Subscribing...'
                      : isRtl
                        ? 'اشتراك'
                        : 'Subscribe'}
                  </button>
                  {errorMsg && (
                    <p className="text-xs text-destructive" role="alert">
                      {errorMsg}
                    </p>
                  )}
                </form>
              )}
            </div>
          )}
        </div>

        {/* Bottom bar removed 2026-05-21 — redundant with Company Links. */}
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce />
      </div>
    </footer>
  );
}
