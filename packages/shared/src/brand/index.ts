/**
 * Ebda brand identity — the single source of truth for every user-visible
 * brand string, colour, font, domain and sender address across apps/* and
 * packages/*. Import from `@ebda/shared` (the package scope is an internal
 * identifier and is intentionally unchanged).
 *
 * Pure data + pure helpers: no runtime imports, safe in Workers, middleware,
 * Next.js client bundles and Node alike. Do not re-hardcode these values
 * elsewhere; `tests/unit/no-force-branding.test.ts` guards against inherited third-party brand strings.
 */

export const BRAND = {
  name: 'Ebda AI Studio',
  nameAr: 'ابدأ استوديو للذكاء الاصطناعي',
  /**
   * The PRODUCT (the store builder). `name`/`nameAr` above name the company; anything naming the product or the Service
   * reads this (ruling PRODUCT-NAME-1). Future products: Ebda WhatsApp / CRM / ERP.
   */
  product: {
    nameEn: 'Ebda Store',
    nameAr: 'ابدأ ستور',
  },
  /** The company behind Ebda (single source for every operator mention; ruling OPERATOR-1). */
  company: {
    legalNameAr: 'ابدأ استوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
    legalNameEn: 'Ebda AI Studio for Artificial Intelligence, Software and Digital Marketing',
    shortNameAr: 'ابدأ استوديو للذكاء الاصطناعي',
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
    /**
     * The Ebda Store merchant app (sign-up, plan, payment, onboarding, dashboard).
     * `admin.ebda.app` is RETIRED (Ruling HOST-STORE-1): no surface, reserved slug, 404.
     * Future products follow the same pattern (`whatsapp.`, `crm.`, one login at `accounts.`).
     */
    storeApp: 'store.ebda.app',
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
  /**
   * Public WhatsApp line for pre-sales questions (the marketing site header, FAQ and close).
   * E.164 with the leading +; use `whatsappUrl()` / `whatsappDisplay()` to render it.
   */
  contact: {
    whatsapp: '+201207761882',
  },
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

/** Product name for merchant/store surfaces, separate from the company identity. */
export function productName(locale?: string | null): string {
  return locale?.toLowerCase().startsWith('ar') ? BRAND.product.nameAr : BRAND.product.nameEn;
}

/** `https://<host>` for a bare hostname. */
export function brandUrl(host: string): string {
  return `https://${host}`;
}

/** Marketing site origin, e.g. `https://ebda.app`. */
export const BRAND_MARKETING_URL = brandUrl(BRAND.domains.marketing);
/** Ebda Store merchant app origin, e.g. `https://store.ebda.app`. */
export const BRAND_STORE_APP_URL = brandUrl(BRAND.domains.storeApp);
/** API origin, e.g. `https://api.ebda.app`. */
export const BRAND_API_URL = brandUrl(BRAND.domains.api);

/** `https://wa.me/<digits>` for the public WhatsApp line (digits only, no +), optional prefilled text. */
export function whatsappUrl(text?: string): string {
  const url = `https://wa.me/${BRAND.contact.whatsapp.replace(/\D/g, '')}`;
  return text ? `${url}?text=${encodeURIComponent(text)}` : url;
}

/** The WhatsApp number for display, e.g. `+20 120 776 1882` (render left-to-right, selectable). */
export function whatsappDisplay(): string {
  return BRAND.contact.whatsapp.replace(/^\+20(\d{3})(\d{3})(\d{4})$/, '+20 $1 $2 $3');
}

/** Hosted PNG of the mark for transactional email (mail clients drop SVG). */
export const BRAND_EMAIL_LOGO_URL = `${BRAND_MARKETING_URL}/email-logo.png`;

/**
 * The approved Ebda mark (2026-10-22 logo pack: three gold faces forming a doorway) as an inline SVG
 * string, 78.3x149 viewBox (width = size x 0.526). Same geometry + gradients as brand/logo/svg/03d-symbol-gold.svg.
 * Gradient ids are fixed (`ebda-mark-*`): repeats of the mark on one page carry identical defs, which is valid.
 * Decorative by default; `size` is the rendered HEIGHT in px.
 */
const MARK_DEFS = `<defs><linearGradient id="ebda-mark-lint" gradientUnits="userSpaceOnUse" x1="47.04" y1="5.06" x2="58.87" y2="78.05"><stop offset="0.0" stop-color="#DAB27A"/><stop offset="0.056" stop-color="#DAB27A"/><stop offset="0.167" stop-color="#D2AA73"/><stop offset="0.278" stop-color="#CCA46E"/><stop offset="0.389" stop-color="#C8A06A"/><stop offset="0.5" stop-color="#C49C67"/><stop offset="0.611" stop-color="#BE9662"/><stop offset="0.722" stop-color="#B78E5C"/><stop offset="0.833" stop-color="#AE8656"/><stop offset="0.944" stop-color="#A57E52"/><stop offset="1.0" stop-color="#A57E52"/></linearGradient><linearGradient id="ebda-mark-col" gradientUnits="userSpaceOnUse" x1="54.53" y1="77.53" x2="89.44" y2="116.79"><stop offset="0.0" stop-color="#A27B4E"/><stop offset="0.056" stop-color="#A27B4E"/><stop offset="0.167" stop-color="#A17A4D"/><stop offset="0.278" stop-color="#9D774B"/><stop offset="0.389" stop-color="#987448"/><stop offset="0.5" stop-color="#946F44"/><stop offset="0.611" stop-color="#906C42"/><stop offset="0.722" stop-color="#8E6A40"/><stop offset="0.833" stop-color="#8B673F"/><stop offset="0.944" stop-color="#8A663E"/><stop offset="1.0" stop-color="#8A663E"/></linearGradient><linearGradient id="ebda-mark-left" gradientUnits="userSpaceOnUse" x1="-10.44" y1="99.88" x2="48.82" y2="87.05"><stop offset="0.0" stop-color="#B99160"/><stop offset="0.056" stop-color="#B99160"/><stop offset="0.167" stop-color="#B0895B"/><stop offset="0.278" stop-color="#A68156"/><stop offset="0.389" stop-color="#9F7B51"/><stop offset="0.5" stop-color="#9A774D"/><stop offset="0.611" stop-color="#957249"/><stop offset="0.722" stop-color="#906D45"/><stop offset="0.833" stop-color="#8C6A43"/><stop offset="0.944" stop-color="#8B6942"/><stop offset="1.0" stop-color="#8B6942"/></linearGradient></defs>`;
const MARK_PATHS =
  `<path d="M65.70 67.60 L78.30 73.90 L78.30 126.70 L65.70 120.50Z" fill="url(#ebda-mark-col)"/>` +
  `<path d="M0.00 35.80 L78.30 0.00 L78.30 74.90Z" fill="url(#ebda-mark-lint)"/>` +
  `<path d="M0.00 37.00 L42.60 58.30 L42.10 127.80 L0.20 149.00Z" fill="url(#ebda-mark-left)"/>`;

export function brandMarkSvg(opts: { size?: number; cls?: string } = {}): string {
  const h = opts.size ?? 28;
  const w = Math.round(h * 0.5255 * 100) / 100;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 78.3 149" width="${w}" height="${h}"${cls} aria-hidden="true" focusable="false">` +
    MARK_DEFS +
    MARK_PATHS +
    `</svg>`
  );
}

/**
 * The app-icon tile (night rounded square + the mark, as brand/logo/svg/05d-favicon-32.svg) as an inline SVG
 * string, for places that cannot link a file (the status page's data-URI favicon).
 */
export function brandAppIconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<rect width="1024" height="1024" rx="229.07" fill="${BRAND.colors.night}"/>` +
    `<g transform="translate(318.278 143.360) scale(4.94819)">${MARK_DEFS}${MARK_PATHS}</g></svg>`
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

/** RFC 5322 `From:` value, e.g. `Ebda Store <no-reply@ebda.app>` (store mail) or `Ebda AI Studio <...>` (account mail). */
export function brandFrom(displayName: string = BRAND.product.nameEn): string {
  // BRAND-NAME-1: never the bare master name as a sender (an inbox shows "Ebda", not the product).
  if (displayName.trim().toLowerCase() === 'ebda') {
    throw new Error('brandFrom: the sender name must not be the bare brand, name the product');
  }
  return `${displayName} <${BRAND.noReplyEmail}>`;
}

/** Footer line for transactional email / storefront: "Powered by Ebda Store". */
export function poweredByBrand(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar')
    ? `مدعوم من ${BRAND.product.nameAr}`
    : `Powered by ${BRAND.product.nameEn}`;
}

// ---- shared header navigation of the support sites (docs, help, status) ----
/**
 * The ONE header navigation of the three Ebda AI Studio support sites (docs, help, status): the wordmark lockup, the
 * Products menu, the five site links and the mobile menu. docs and help render it through packages/site-kit's page
 * shell, status through its own Worker renderer; both call these functions, so the three always show the same links,
 * in the same order, with the same labels in ar and en. Pure strings, no imports beyond the brand module (the status
 * Worker may import nothing else). It lives inside the brand module on purpose: the docs and help builders load it as bare TypeScript through Node, which
 * cannot resolve an extensionless sibling import, and the status Worker may import this module only.
 */
export type NavLang = 'ar' | 'en';
/** The site a page belongs to: its link gets `aria-current="page"`. `null` = none (a page of another site). */
export type NavSite = 'studio' | 'dashboard' | 'docs' | 'help' | 'status';

export interface SiteNavItem {
  id: NavSite;
  href: string;
  label: string;
}
export interface SiteNavProduct {
  id: 'store' | 'whatsapp';
  href: string;
  label: string;
  blurb: string;
}

const L = (lang: NavLang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const marketing = (lang: NavLang) => `${BRAND_MARKETING_URL}${lang === 'ar' ? '/' : '/en/'}`;

/** The five site links, in the one order every support site shows them. */
export function siteNavItems(lang: NavLang): SiteNavItem[] {
  const d = BRAND.domains;
  return [
    {
      id: 'studio',
      href: marketing(lang),
      label: lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn,
    },
    { id: 'dashboard', href: BRAND_STORE_APP_URL, label: L(lang, 'لوحة التحكم', 'Dashboard') },
    // docs: English at the root, Arabic under /ar/. help and status: Arabic at the root, English under /en.
    {
      id: 'docs',
      href: `https://${d.docs}/${lang === 'ar' ? 'ar/' : ''}`,
      label: L(lang, 'الوثائق', 'Docs'),
    },
    {
      id: 'help',
      href: `https://${d.help}/${lang === 'ar' ? '' : 'en/'}`,
      label: L(lang, 'مركز المساعدة', 'Help centre'),
    },
    {
      id: 'status',
      href: `https://${d.status}/${lang === 'ar' ? '' : 'en'}`,
      label: L(lang, 'حالة الخدمة', 'Status'),
    },
  ];
}

/** The Products menu: only live products (BRAND-ARCH-1). Same entry as the marketing header's menu. */
export function siteNavProducts(lang: NavLang): SiteNavProduct[] {
  return [
    {
      id: 'store',
      href: marketing(lang),
      label: lang === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn,
      // the marketing header's own storeBlurb (apps/marketing content.ts); tests/unit/site-nav-shared.test.ts keeps them equal
      blurb: L(lang, 'متجرك أونلاين في دقايق', 'Your online store in minutes'),
    },
    {
      id: 'whatsapp',
      href: `${marketing(lang)}whatsapp/`,
      label: L(lang, 'ابدأ واتساب', 'Ebda WhatsApp'),
      blurb: L(
        lang,
        'واتساب لمتجرك: ردود وحملات وطلبات',
        'WhatsApp for your store: chats, campaigns, orders'
      ),
    },
  ];
}

export const siteNavLabels = (lang: NavLang) => ({
  nav: L(lang, 'التنقل الرئيسي', 'Main navigation'),
  products: L(lang, 'المنتجات', 'Products'),
  menu: L(lang, 'القائمة', 'Menu'),
});

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

/** The studio lockup: mark + the master brand name + the site name. `markHtml` is the caller's icon (an <img> or inline SVG). */
export function siteWordmarkHtml(p: {
  lang: NavLang;
  href: string;
  siteLabel: string;
  markHtml: string;
}): string {
  const studio = p.lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  return `<a class="wordmark" href="${esc(p.href)}">${p.markHtml}<span>${esc(studio)}</span><span class="wm-site">${esc(p.siteLabel)}</span></a>`;
}

/** The header nav: desktop link row with the Products disclosure, and the mobile menu (below 1180px it collapses into the menu button; wider, it is its own row under the wordmark, search and language switch). */
export function siteNavHtml(lang: NavLang, active: NavSite | null): string {
  const t = siteNavLabels(lang);
  const items = siteNavItems(lang);
  const products = siteNavProducts(lang);
  const link = (i: SiteNavItem) =>
    `<li><a href="${esc(i.href)}"${i.id === active ? ' aria-current="page"' : ''}>${esc(i.label)}</a></li>`;
  const prod = (p: SiteNavProduct) =>
    `<li><a href="${esc(p.href)}"><b>${esc(p.label)}</b><span>${esc(p.blurb)}</span></a></li>`;
  return (
    `<nav class="top-nav" aria-label="${esc(t.nav)}">` +
    `<ul class="nav-links"><li class="nav-products"><details><summary>${esc(t.products)}</summary><ul>${products.map(prod).join('')}</ul></details></li>${items.map(link).join('')}</ul>` +
    `<details class="nav-menu"><summary><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg><span>${esc(t.menu)}</span></summary>` +
    `<ul>${products.map(p => `<li><a href="${esc(p.href)}">${esc(p.label)}</a></li>`).join('')}${items.map(link).join('')}</ul></details>` +
    `</nav>`
  );
}

/** Stylesheet for the wordmark and the nav above. Uses the sites' shared tokens (--fg --muted --line --lift --panel --night). */
export const SITE_NAV_CSS = `
.top-nav{order:3;flex:1 1 100%;min-width:0;position:relative}
.top-nav ul{list-style:none;margin:0;padding:0}
.top-nav .nav-links{display:flex;flex-wrap:nowrap;align-items:center;gap:4px 16px;white-space:nowrap}
.top-nav a{color:var(--fg);text-decoration:none;padding:6px 2px;display:inline-block}
.top-nav a:hover{color:var(--lift)}
.top-nav a[aria-current=page]{color:var(--lift);border-bottom:2px solid var(--lift)}
.top-nav summary{cursor:pointer;list-style:none;color:var(--fg);padding:6px 2px;display:inline-flex;align-items:center;gap:6px}
.top-nav summary::-webkit-details-marker{display:none}
.nav-products>details>summary::after{content:"";width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);margin-block-start:-3px}
.nav-products>details>ul,.nav-menu>ul{position:absolute;z-index:60;min-width:230px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;margin-block-start:6px}
.nav-products li a{display:block;padding:8px 10px;border-radius:8px}
.nav-products li a b{display:block}
.nav-products li a span{display:block;color:var(--muted);font-size:.85rem}
.nav-menu{display:none}
.nav-menu>ul a{display:block;padding:10px;min-height:44px}
@media (max-width:1179px){.top-nav{order:0;flex:0 0 auto;margin-inline-start:auto}.top-nav .nav-links{display:none}.nav-menu{display:block}}
`.replace(/\n/g, '');
