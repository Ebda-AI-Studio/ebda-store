/**
 * Ebda brand identity — the single source of truth for every user-visible
 * brand string, colour, font, domain and sender address across apps/* and
 * packages/*. Import from `@force/shared` (the package scope is an internal
 * identifier and is intentionally unchanged).
 *
 * Pure data + pure helpers: no runtime imports, safe in Workers, middleware,
 * Next.js client bundles and Node alike. Do not re-hardcode these values
 * elsewhere; `tests/unit/no-fwb-branding.test.ts` guards the old FWB strings.
 */

export const BRAND = {
  name: 'Ebda',
  nameAr: 'ابدأ',
  company: 'Whisky 11',
  tagline: 'Your store, live today.',
  taglineAr: 'متجرك أونلاين النهاردة.',
  colors: {
    night: '#0A0B0C',
    gold: '#B08D57',
    lift: '#CBA873',
  },
  fonts: {
    sans: 'Geist',
    mono: 'Geist Mono',
    arabic: 'IBM Plex Sans Arabic',
    stacks: {
      sans: '"Geist", ui-sans-serif, system-ui, sans-serif',
      mono: '"Geist Mono", ui-monospace, "SFMono-Regular", monospace',
      arabic: '"IBM Plex Sans Arabic", ui-sans-serif, system-ui, sans-serif',
    },
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500&display=swap',
  },
  domains: {
    marketing: 'ebda.app',
    admin: 'admin.ebda.app',
    api: 'api.ebda.app',
    orders: 'orders.ebda.app',
    storeSuffix: '.ebda.app',
    docs: 'docs.ebda.app',
    help: 'help.ebda.app',
    status: 'status.ebda.app',
    /** Reserved for the post-launch automated WhatsApp tier. */
    whatsapp: 'whatsapp.ebda.app',
  },
  supportEmail: 'support@ebda.app',
  noReplyEmail: 'no-reply@ebda.app',
  legalUrls: {
    terms: 'https://ebda.app/terms',
    privacy: 'https://ebda.app/privacy',
    refunds: 'https://ebda.app/refunds',
  },
} as const;

export type Brand = typeof BRAND;

/** Brand name for a locale (`ar*` → Arabic wordmark, everything else Latin). */
export function brandName(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar') ? BRAND.nameAr : BRAND.name;
}

/** `https://<host>` for a bare hostname. */
export function brandUrl(host: string): string {
  return `https://${host}`;
}

/** Marketing site origin, e.g. `https://ebda.app`. */
export const BRAND_MARKETING_URL = brandUrl(BRAND.domains.marketing);
/** Merchant dashboard origin, e.g. `https://admin.ebda.app`. */
export const BRAND_ADMIN_URL = brandUrl(BRAND.domains.admin);
/** API origin, e.g. `https://api.ebda.app`. */
export const BRAND_API_URL = brandUrl(BRAND.domains.api);

/** Free storefront hostname for a slug: `<slug>.ebda.app`. */
export function storeHost(slug: string): string {
  return `${slug.trim().toLowerCase()}${BRAND.domains.storeSuffix}`;
}

/** Free storefront origin for a slug: `https://<slug>.ebda.app`. */
export function storeOrigin(slug: string): string {
  return brandUrl(storeHost(slug));
}

/** True for `ebda.app` itself or any `*.ebda.app` host (port stripped, case-insensitive). */
export function isBrandHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === BRAND.domains.marketing || h.endsWith(BRAND.domains.storeSuffix);
}

/** RFC 5322 `From:` value, e.g. `Ebda <no-reply@ebda.app>`. */
export function brandFrom(displayName: string = BRAND.name): string {
  return `${displayName} <${BRAND.noReplyEmail}>`;
}

/** Footer line for transactional email / storefront: "Powered by Ebda". */
export function poweredByBrand(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar')
    ? `مدعوم من ${BRAND.nameAr}`
    : `Powered by ${BRAND.name}`;
}
