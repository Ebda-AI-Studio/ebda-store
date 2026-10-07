/**
 * Ebda brand identity — the single source of truth for every user-visible
 * brand string, colour, font, domain and sender address across apps/* and
 * packages/*. Import from `@force/shared` (the package scope is an internal
 * identifier and is intentionally unchanged).
 *
 * Pure data + pure helpers: no runtime imports, safe in Workers, middleware,
 * Next.js client bundles and Node alike. Do not re-hardcode these values
 * elsewhere; `tests/unit/no-force-branding.test.ts` guards against inherited third-party brand strings.
 */

export const BRAND = {
  name: 'Ebda',
  nameAr: 'ابدأ',
  /**
   * The PRODUCT (the store builder). `name`/`nameAr` above stay the master
   * brand (logo, brand line); anything that names the product or the Service
   * reads this (ruling PRODUCT-NAME-1). Future products: Ebda WhatsApp / CRM / ERP.
   */
  product: {
    nameEn: 'Ebda Store',
    nameAr: 'ابدأ ستور',
  },
  /** The company behind Ebda (single source for every operator mention; ruling OPERATOR-1). */
  company: {
    legalNameAr: 'ابدأ ستوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
    legalNameEn: 'Ebda AI Studio for Artificial Intelligence, Software and Digital Marketing',
    shortNameAr: 'ابدأ ستوديو',
    shortNameEn: 'Ebda AI Studio',
    url: 'https://ebda.app',
  },
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
  /**
   * The ONE public contact address. Only hello@ and security@ receive mail
   * (Cloudflare Email Routing), so this must stay hello@ (Ruling EBDA-BILLFU-5).
   */
  supportEmail: 'ahlan@ebda.app',
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

/** Hosted PNG of the mark for transactional email (mail clients drop SVG). */
export const BRAND_EMAIL_LOGO_URL = `${BRAND_MARKETING_URL}/email-logo.png`;

/**
 * The approved Ebda "open door" mark as an inline SVG string (90x90 viewBox).
 * Same geometry as brand/logo/ebda-mark.svg; `arch` / `light` are CSS colours
 * (a `var(--x)` works inside an HTML page). Decorative by default.
 */
export function brandMarkSvg(
  opts: { arch?: string; light?: string; size?: number; cls?: string } = {}
): string {
  const arch = opts.arch ?? BRAND.colors.gold;
  const light = opts.light ?? BRAND.colors.lift;
  const size = opts.size ?? 28;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="13 19 90 90" width="${size}" height="${size}"${cls} aria-hidden="true" focusable="false">` +
    `<path d="M58 83 L44 100 H72 Z" fill="${arch}" opacity=".35"/>` +
    `<path d="M30 100 V56 a28 28 0 0 1 56 0 V100" fill="none" stroke="${arch}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="58" cy="74" r="9" fill="${light}"/></svg>`
  );
}

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

/** RFC 5322 `From:` value, e.g. `Ebda Store <no-reply@ebda.app>`. */
export function brandFrom(displayName: string = BRAND.product.nameEn): string {
  return `${displayName} <${BRAND.noReplyEmail}>`;
}

/** Footer line for transactional email / storefront: "Powered by Ebda". */
export function poweredByBrand(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar')
    ? `مدعوم من ${BRAND.nameAr}`
    : `Powered by ${BRAND.name}`;
}
