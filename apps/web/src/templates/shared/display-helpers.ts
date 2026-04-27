/**
 * Shared display helpers used across all template components.
 *
 * These centralise the RTL-aware text selection and discount calculation
 * logic that was previously duplicated in every template.
 */

import type { FooterLinkSection, FooterLinksConfig, StoreBranding } from '../types';

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
