/**
 * Shared display helpers used across all template components.
 *
 * These centralise the RTL-aware text selection and discount calculation
 * logic that was previously duplicated in every template.
 */

import { sanitizeUrl, type StoreLocationPublic, type StoreTheme } from '@ebda/shared';
import { translations } from '../../contexts/LanguageContext';
import type {
  FooterBottomBarConfig,
  FooterLinkSection,
  FooterLinksConfig,
  StoreBranding,
} from '../types';

/**
 * A single footer column ready to render: header copy already picked for the
 * active direction, plus the filtered/active links. The `key` is stable
 * (`shop` / `company` / `support`) so templates can react keys + apply
 * section-specific styling if needed.
 */
export interface ResolvedFooterSection {
  key: 'shop' | 'company' | 'support';
  heading: string;
  links: Array<{ label: string; href: string }>;
}

/**
 * Return the appropriate text based on RTL mode.
 * If RTL is active and an Arabic variant exists, use it; otherwise fall back
 * to the default text.
 */
/**
 * Locale-picked NAME of a product / category / bundle (issue #2110, the #1805
 * class). `nameAr ?? name` is NOT a fallback for this data: the API accepts
 * `nameAr: ''` (no `.min(1)`), and `??` only falls back on null/undefined, so
 * an Arabic shopper saw a BLANK product name. A blank or whitespace-only value
 * in either language falls back to the other; `undefined` only when both are
 * blank (callers supply their own final fallback).
 */
export function pickLocalizedName(
  entity: { name?: string | null; nameAr?: string | null } | null | undefined,
  isRtl: boolean
): string | undefined {
  const en = entity?.name?.trim() ? entity.name : undefined;
  const ar = entity?.nameAr?.trim() ? entity.nameAr : undefined;
  return (isRtl ? (ar ?? en) : (en ?? ar)) ?? undefined;
}

export function getDisplayText<T extends string | undefined>(
  text: T,
  textAr: string | undefined,
  isRtl: boolean
): T {
  return (isRtl && textAr ? textAr : text) as T;
}

/**
 * Derive display-ready branding values (name, logo, description) from a
 * `StoreBranding` object, respecting the current text direction.
 */
export function getDisplayBranding(
  branding: StoreBranding,
  isRtl: boolean
): { name: string; logo: string | undefined; description: string | undefined } {
  return {
    name: getDisplayText(branding.name, branding.nameAr, isRtl),
    logo: getDisplayText(branding.logo, branding.logoAr, isRtl),
    description: getDisplayText(branding.description, branding.descriptionAr, isRtl),
  };
}

/**
 * Calculate the discount percentage between a compare-at price and the
 * current price.  Returns 0 when no valid discount exists.
 */
export function calculateDiscount(price: number, compareAtPrice: number | undefined): number {
  if (!compareAtPrice || compareAtPrice <= price) return 0;
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
}

const FOOTER_SECTION_HEADINGS: Record<ResolvedFooterSection['key'], { en: string; ar: string }> = {
  shop: { en: 'Shop', ar: 'تسوق' },
  company: { en: 'Company', ar: 'الشركة' },
  support: { en: 'Support', ar: 'الدعم' },
};

/**
 * Arabic fallback for the platform's seeded footer-link names. Legacy stores
 * saved their `footerLinks` before we added the `nameAr` field, so their
 * persisted JSON has English-only labels. We can't migrate existing rows
 * without losing tenant overrides, but we can map the common platform-default
 * names to Arabic at render time. Custom labels typed by the merchant fall
 * through unchanged.
 */
const ARABIC_LABEL_FALLBACK: Record<string, string> = {
  // Shop
  'All Products': 'كل المنتجات',
  Categories: 'الفئات',
  'New Arrivals': 'أحدث المنتجات',
  'Best Sellers': 'الأكثر مبيعاً',
  'On Sale': 'العروض',
  // Support
  'Contact Us': 'تواصل معنا',
  FAQ: 'الأسئلة الشائعة',
  'Shipping Info': 'معلومات الشحن',
  'Returns & Refunds': 'الإرجاع والاسترداد',
  'How-To Guides': 'أدلة الاستخدام',
  // Company
  'About Us': 'من نحن',
  'Privacy Policy': 'سياسة الخصوصية',
  'Terms of Service': 'الشروط والأحكام',
};

function resolveLinkLabel(name: string, nameAr: string | undefined, isRtl: boolean): string {
  if (!isRtl) return name;
  return nameAr ?? ARABIC_LABEL_FALLBACK[name] ?? name;
}

function resolveFooterSection(
  key: ResolvedFooterSection['key'],
  links: FooterLinkSection[] | undefined,
  isRtl: boolean
): ResolvedFooterSection | null {
  if (!Array.isArray(links) || links.length === 0) return null;
  const active = links
    .filter(link => link.enabled !== false)
    .map(link => ({
      label: resolveLinkLabel(link.name, link.nameAr, isRtl),
      href: link.href,
    }));
  if (active.length === 0) return null;
  return {
    key,
    heading: isRtl ? FOOTER_SECTION_HEADINGS[key].ar : FOOTER_SECTION_HEADINGS[key].en,
    links: active,
  };
}

/**
 * Turn the raw `FooterLinksConfig` into the ordered list of sections each
 * template should render. Empty/disabled-only sections are dropped, and
 * Arabic labels are picked when `isRtl` is true. Returns `[]` when no
 * section has any active links — templates use that to fall back to their
 * built-in default column layout.
 */
export function resolveFooterSections(
  config: FooterLinksConfig | undefined,
  isRtl: boolean
): ResolvedFooterSection[] {
  if (!config) return [];
  return [
    resolveFooterSection('shop', config.shop, isRtl),
    resolveFooterSection('company', config.company, isRtl),
    resolveFooterSection('support', config.support, isRtl),
  ].filter((s): s is ResolvedFooterSection => s !== null);
}

/**
 * Whether the newsletter form should render given the per-store config.
 * Defaults to `true` (preserve existing behaviour) when the config or the
 * `newsletterEnabled` flag is absent.
 */
export function isNewsletterEnabled(config: FooterLinksConfig | undefined): boolean {
  return config?.newsletterEnabled !== false;
}

/**
 * Resolved bottom-bar configuration ready for footer templates. All booleans
 * default to `true` so stores that haven't visited the new admin section keep
 * seeing the bar with the legacy Privacy + Terms links. Shipping is part of
 * the default set — Elegant has always rendered it; the others now match.
 */
export interface ResolvedBottomBar {
  enabled: boolean;
  copyright: string | null;
  privacyEnabled: boolean;
  termsEnabled: boolean;
  shippingEnabled: boolean;
  /** The returns-policy link (S-01): on unless the merchant turned it off. */
  returnsEnabled: boolean;
}

/**
 * Resolve the bottom bar config into a render-ready object. `storeName` is
 * used to build the default copyright string; pass the RTL-aware display
 * name. `isRtl` selects between English / Arabic copyright suffix. Pass
 * `bottomBar` from `store.settings.footerLinks.bottomBar` (or omit when
 * unset — the defaults preserve historic behaviour).
 *
 * `disabledCmsSlugs` is the list of CMS pages the merchant has explicitly
 * turned off (`isPublished=false`). When a slug appears here we hide the
 * matching legal link in the bottom bar, even if the merchant's per-link
 * toggle is on. This way a merchant disabling the Privacy CMS page in
 * `/content/privacy` automatically removes the dead "Privacy" link from
 * every pack's footer without them having to flip both controls.
 */
export function resolveBottomBar(
  bottomBar: FooterBottomBarConfig | undefined,
  storeName: string,
  isRtl: boolean,
  disabledCmsSlugs: string[] | undefined,
  /** The © year. Passed in (the per-request render clock), never read here: a clock read in a
   *  helper is a hydration mismatch when server and browser straddle New Year (FU46 I-1). */
  year: number
): ResolvedBottomBar {
  const enabled = bottomBar?.enabled !== false;
  const overrideRaw = isRtl
    ? (bottomBar?.copyrightOverrideAr ?? bottomBar?.copyrightOverride)
    : bottomBar?.copyrightOverride;
  // Clamped on read: a legacy row may hold more than the 200 the editor now allows (FU46 M-7).
  const override = typeof overrideRaw === 'string' ? overrideRaw.trim().slice(0, 200) : '';
  const name = storeName.trim();
  const fallback = isRtl
    ? `© ${year} ${name ? `${name}.` : '·'} جميع الحقوق محفوظة.`
    : `© ${year} ${name ? `${name}.` : '·'} All rights reserved.`;
  const disabled = new Set(disabledCmsSlugs ?? []);
  return {
    enabled,
    copyright: enabled ? override || fallback : null,
    // Per-link state is the AND of (merchant toggled ON) AND (CMS page
    // not explicitly turned off). Either gate flips the link off.
    privacyEnabled: bottomBar?.privacyEnabled !== false && !disabled.has('privacy'),
    termsEnabled: bottomBar?.termsEnabled !== false && !disabled.has('terms'),
    shippingEnabled: bottomBar?.shippingEnabled !== false && !disabled.has('shipping'),
    returnsEnabled: bottomBar?.returnsEnabled !== false && !disabled.has('returns'),
  };
}

/**
 * Whether the address should render as a clickable hyperlink given the
 * per-store flag. Defaults to `true` when the flag is unset so existing
 * stores keep their current behaviour. The flag is normalised to a boolean
 * — legacy values ('maps' / 'none' from the prior implementation) are also
 * accepted so we don't break stored settings while a tenant migrates.
 */
export function isAddressMapLinkEnabled(addressLink: boolean | undefined): boolean {
  return addressLink !== false;
}

/**
 * Resolve which URL the footer's address `<a>` should point at, if any.
 *
 * Rules (in order):
 *   1. Tenant disabled the link entirely (`addressLink === false`) → null.
 *   2. Tenant pasted an explicit map URL → use that verbatim.
 *   3. Otherwise fall back to a Google-Maps "search" link built from the
 *      address text (preserves the long-standing default).
 *   4. Empty / whitespace-only address with no explicit URL → null.
 *
 * Returns `null` when the caller should render plain text instead of an
 * anchor.
 */
export function resolveAddressHref(
  address: string | undefined,
  addressUrl: string | undefined,
  addressLink: boolean | undefined
): string | null {
  if (addressLink === false) return null;
  const trimmedUrl = addressUrl?.trim();
  if (trimmedUrl) {
    // Defence-in-depth: sanitize the merchant-supplied URL so a
    // `javascript:` / `data:` value stored before the server-side
    // `safeOptionalUrl` guard was deployed can't execute at render time.
    // An unsafe value falls back to the synthesised Google Maps URL so
    // the address text remains linked (rather than silently unwrapped).
    const safe = sanitizeUrl(trimmedUrl, '');
    if (safe) return safe;
    // Unsafe explicit URL → fall through to the auto-generated Maps link.
  }
  return buildMapsHref(address);
}

/**
 * Build a Google Maps "search" URL for an address string. Returns `null`
 * when the address is empty after trimming so callers can skip rendering
 * an `<a>` wrapper around an empty string.
 */
export function buildMapsHref(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}

/** A store location ready to render in the footer's "Branches" column. */
export interface ResolvedFooterLocation {
  id: string;
  name: string;
  address: string;
  /** Sanitized http(s) maps link, or undefined when absent/unsafe. */
  mapsHref?: string;
  /** Raw phone string for a `tel:` link, or undefined when absent. */
  phone?: string;
}

/**
 * The footer "Branches" column heading — routed through the storefront's
 * `translations` map (LanguageContext.tsx) rather than hardcoded in a theme,
 * per the platform's storefront-copy rule.
 */
export function footerBranchesHeading(isRtl: boolean): string {
  return isRtl ? translations.Branches : 'Branches';
}

/**
 * Resolve the opt-in "Branches" footer column. Returns `[]` (render nothing)
 * unless BOTH gates hold: the merchant turned `theme.showBranchesInFooter` on
 * AND at least one published location was forwarded. This is the single
 * source of truth every theme's Footer calls — `locations` being present on
 * the props does NOT by itself mean the column should render (the API only
 * omits the array when the flag is off, but a theme must never assume that
 * and skip re-checking the flag itself, since props can be hand-passed in
 * tests/storybook-style usage without going through the real API gate).
 *
 * Rows missing a usable name+address are dropped rather than rendered blank.
 */
export function resolveFooterBranches(
  locations: StoreLocationPublic[] | undefined,
  theme: StoreTheme | undefined,
  isRtl: boolean
): ResolvedFooterLocation[] {
  if (theme?.showBranchesInFooter !== true) return [];
  if (!Array.isArray(locations) || locations.length === 0) return [];
  return locations
    .map((loc): ResolvedFooterLocation | null => {
      const name = getDisplayText(loc.name, loc.nameAr ?? undefined, isRtl);
      const address = getDisplayText(loc.address, loc.addressAr ?? undefined, isRtl);
      if (!name?.trim() || !address?.trim()) return null;
      const mapsHref = loc.mapsUrl ? sanitizeUrl(loc.mapsUrl, '') || undefined : undefined;
      const phone = loc.phone?.trim() || undefined;
      return { id: loc.id, name, address, mapsHref, phone };
    })
    .filter((l): l is ResolvedFooterLocation => l !== null);
}
