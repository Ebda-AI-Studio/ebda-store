'use client';

import Link from 'next/link';
import { PoweredByForce } from '../shared/PoweredByForce';
import { useState } from 'react';
import type { FooterProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import {
  footerBranchesHeading,
  isNewsletterEnabled,
  resolveAddressHref,
  resolveFooterBranches,
  resolveFooterSections,
} from '../shared/display-helpers';
import { getSocialLinks, SocialGlyph } from '../shared/icons';

export default function ElegantFooter({
  branding,
  hidePoweredBy,
  contact,
  socials,
  navigation = [],
  footerLinks,
  isRtl: isRtlProp,
  bgColor,
  footerLogo,
  hideFooterLogoMobile,
  footerLogoAutoFilter,
  theme,
  locations,
}: FooterProps) {
  const { isRtl: ctxIsRtl, language } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = footerLogo || (isRtl && branding.logoAr ? branding.logoAr : branding.logo);
  const displayDescription =
    isRtl && branding.descriptionAr ? branding.descriptionAr : branding.description;
  const displayPhone = isRtl && contact.phoneAr ? contact.phoneAr : contact.phone;
  const displayAddress = isRtl && contact.addressAr ? contact.addressAr : contact.address;

  // Pass `contact` so the merchant's WhatsApp phone shows up in the social
  // row even when no full URL is saved in `socials.whatsapp`.
  const socialLinks = getSocialLinks(socials, contact, theme?.socialOrder);
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
  const addressMapHref = resolveAddressHref(
    displayAddress,
    contact.addressUrl,
    contact.addressLink
  );
  // Opt-in "Branches" column — see resolveFooterBranches for the gating
  // rules. Off (+0) reduces this to the pre-existing footerSections-only
  // formula below, so the toggle-off render is byte-identical.
  const branches = resolveFooterBranches(locations, theme, isRtl);
  const showBranches = branches.length > 0;
  const baseCols = footerSections.length >= 3 ? 6 : footerSections.length === 2 ? 5 : 4;
  const totalCols = baseCols + (showBranches ? 1 : 0);
  const gridColsClass =
    totalCols >= 7
      ? 'md:grid-cols-7'
      : totalCols === 6
        ? 'md:grid-cols-6'
        : totalCols === 5
          ? 'md:grid-cols-5'
          : 'md:grid-cols-4';

  return (
    <footer
      data-zone="footer"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
      className={`${bgColor ? '' : 'bg-[hsl(var(--bg-section-alt))]'} border-t border-border mt-auto`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Newsletter — hidden when the store explicitly opts out. */}
      {showNewsletter && (
        <div className="border-b border-border/50">
          <div className="container mx-auto px-4 py-14 sm:py-16 md:py-20">
            <div className="max-w-xl mx-auto text-center">
              <h3 className="text-xs tracking-[0.3em] ui-caps-toggle text-muted-foreground/70 mb-4 font-serif">
                {isRtl ? 'النشرة البريدية' : 'Newsletter'}
              </h3>
              {/* Body line — render the merchant's brand description when
                  set, otherwise nothing. The previous "Subscribe for
                  exclusive offers and new arrivals" was hardcoded demo
                  copy that wasn't true for every tenant. */}
              {displayDescription && (
                <p className="text-foreground font-light text-lg sm:text-xl mb-8 tracking-wide leading-relaxed">
                  {displayDescription}
                </p>
              )}
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
                      className="h-12 min-w-0 flex-1 px-6 bg-background border border-border focus:border-foreground focus:outline-none text-sm tracking-wide placeholder:text-muted-foreground/50 transition-colors duration-500"
                      dir={isRtl ? 'rtl' : 'ltr'}
                      required
                      disabled={submitting}
                    />
                    <button
                      type="submit"
                      disabled={submitting}
                      className="h-12 px-8 bg-foreground text-background text-xs tracking-[0.2em] ui-caps-toggle hover:bg-foreground/80 transition-colors duration-300 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
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
      <div className="container mx-auto px-4 py-14 sm:py-16 md:py-20 lg:py-24">
        {/* Brand + (sections|explore) + Contact + Follow. Grow the grid so
            extra sections don't crowd the contact / follow columns. */}
        <div className={`grid grid-cols-2 gap-8 sm:gap-10 ${gridColsClass} md:gap-12`}>
          {/* Brand — desktop only. Logo centered at top on mobile (Ahmad 2026-06-20). */}
          <div className="col-span-2 md:col-span-1">
            {displayLogo && !hideFooterLogoMobile && (
              <img
                src={displayLogo}
                alt={displayName}
                className="md:hidden mx-auto h-16 w-auto object-contain mb-5"
                style={
                  !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                    ? { filter: footerLogoAutoFilter }
                    : undefined
                }
              />
            )}
            {displayLogo ? (
              <img
                src={displayLogo}
                alt={displayName}
                className="hidden md:block h-16 sm:h-20 w-auto object-contain mb-6"
                style={
                  !footerLogo && footerLogoAutoFilter && footerLogoAutoFilter !== 'none'
                    ? { filter: footerLogoAutoFilter }
                    : undefined
                }
              />
            ) : (
              <h3 className="hidden md:block text-base font-medium tracking-[0.2em] text-foreground mb-6 font-serif">
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
                <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-semibold text-foreground mb-6 font-serif">
                  {section.heading}
                </h4>
                <ul className="space-y-4">
                  {section.links.map(link => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        // inline-flex + min-h-11 ensures a 44px tap target
                        // on mobile (iOS HIG) without enlarging visible text.
                        className="inline-flex items-center min-h-11 text-sm text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
              <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-semibold text-foreground mb-6 font-serif">
                {isRtl ? 'التصفح' : 'Explore'}
              </h4>
              <ul className="space-y-4">
                {navigation.slice(0, 5).map(item => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-sm text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
              <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-semibold text-foreground mb-6 font-serif">
                {isRtl ? 'تواصل' : 'Contact'}
              </h4>
              <ul className="space-y-4 text-sm">
                {contact.email && (
                  <li>
                    <a
                      href={`mailto:${contact.email}`}
                      className="text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer"
                    >
                      {contact.email}
                    </a>
                  </li>
                )}
                {displayPhone && (
                  <li>
                    <a
                      href={`tel:${contact.phone}`}
                      className="text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer"
                      dir="ltr"
                    >
                      {displayPhone}
                    </a>
                  </li>
                )}
                {displayAddress && (
                  <li className="leading-loose">
                    {addressMapHref ? (
                      <a
                        href={addressMapHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer"
                      >
                        {displayAddress}
                      </a>
                    ) : (
                      <span className="text-foreground/70">{displayAddress}</span>
                    )}
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Social */}
          {socialLinks.length > 0 && (
            <div>
              <div className="flex items-center mb-6">
                <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-semibold text-foreground font-serif">
                  {isRtl ? 'تابعنا' : 'Follow'}
                </h4>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                {socialLinks.map(s => (
                  <a
                    key={s.key}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground/60 hover:text-foreground transition-colors duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    aria-label={s.key}
                  >
                    <SocialGlyph
                      entry={s}
                      className="w-7 h-7"
                      originalColors={theme?.footerSocialOriginalColor === true}
                    />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Branches — opt-in, only rendered when the toggle is on AND at
              least one published location exists. */}
          {showBranches && (
            <div>
              <h4 className="text-xs tracking-[0.25em] ui-caps-toggle font-semibold text-foreground mb-6 font-serif">
                {footerBranchesHeading(isRtl)}
              </h4>
              <ul className="space-y-4 text-sm">
                {branches.map(loc => (
                  <li key={loc.id} className="leading-loose">
                    <p className="text-foreground/90">{loc.name}</p>
                    {loc.mapsHref ? (
                      <a
                        href={loc.mapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer"
                      >
                        {loc.address}
                      </a>
                    ) : (
                      <span className="text-foreground/70">{loc.address}</span>
                    )}
                    {loc.phone && (
                      <a
                        href={`tel:${loc.phone}`}
                        dir="ltr"
                        className="block text-foreground/70 hover:text-foreground transition-colors duration-700 ease-out tracking-wide cursor-pointer"
                      >
                        {loc.phone}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar removed 2026-05-21 — was redundant with the Company
          Links footer section (merchants put Privacy/Terms/Shipping there
          if they want them). PoweredByForce attribution + the per-section
          copyright option are kept. */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <PoweredByForce hidden={hidePoweredBy} />
      </div>
    </footer>
  );
}
