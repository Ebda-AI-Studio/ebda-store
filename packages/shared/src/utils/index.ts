// Shared Utilities

// Export utility modules
export * from './platform';
export * from './discount';
export * from './minimum-order';
export * from './accounting';
export * from './image';
export * from './csv';
export { TEMPLATE_PRESETS, getTemplatePresets } from './template-presets';
export type { TemplateSeeds } from './template-presets';
export { VIBE_PRESETS, getVibePreset } from './vibe-presets';
export type { VibeId, VibePreset } from './vibe-presets';
// Color helpers (smart-color resolver + contrast utilities)
export {
  resolveColor,
  pickReadableForeground,
  contrastRatio,
  parseColorToRgb,
  relativeLuminance,
  COLOR_TOKENS,
  footerLogoContrastFilter,
  colorToHslTriplet,
  rgbToHslTriplet,
  hexToHsl,
  hslToHex,
} from './color';
export type { ColorValue, ColorToken, Rgb } from './color';
export { lightenColor, darkenColor, generateSectionPalette, deriveCoreBrandTokens } from './color';
export type {
  PaletteSeeds,
  SectionPaletteEntry,
  SectionKey,
  PalettePattern,
  CoreBrandTokens,
} from './color';
// Brand engine — palette → contrast-safe storefront CSS vars
export { deriveBrandRoles } from './brand-roles';
// URL-scheme safety (XSS guard for merchant-supplied link fields)
export { isSafeUrl, sanitizeUrl, safeInternalPath } from './safe-url';

/**
 * Format a price value as a localised currency string.
 *
 * By default the input is in fils (1 KWD = 1000 fils) and the output uses
 * KWD with 3 decimal places.  Pass `{ unit: 'kwd' }` if the input is already
 * in the major currency unit.
 *
 * `locale` defaults to `'en'` (Western digits, `en-US` `Intl` locale) so every
 * existing call-site that doesn't pass it renders byte-identical to before.
 * Pass `locale: 'ar'` to render with Arabic-Indic digits (`ar-KW`), matching
 * `getDiscountBadgeText`'s Arabic-locale formatting.
 *
 * @param amount   - The price amount (in fils by default, or KWD if `unit` is `'kwd'`).
 * @param options  - Optional overrides for unit, currency, and locale.
 */
export function formatPrice(
  amount: number,
  options?: { unit?: 'fils' | 'kwd'; currency?: string; locale?: 'en' | 'ar' }
): string {
  const { unit = 'fils', currency = 'KWD', locale = 'en' } = options ?? {};
  const decimals = currency === 'KWD' ? 3 : 2;
  const divisor = unit === 'fils' ? (currency === 'KWD' ? 1000 : 100) : 1;
  const intlLocale = locale === 'ar' ? 'ar-KW' : 'en-US';

  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount / divisor);
}

/** ASCII digit → Eastern Arabic-Indic digit lookup ('0'..'9' → '٠'..'٩'). */
const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/**
 * Convert ASCII digits (0-9) in a string or number to Eastern Arabic-Indic
 * digits (٠١٢٣٤٥٦٧٨٩). Every non-digit character (separators like `.`, `,`,
 * `/`, `-`, `:`, spaces, currency words, letters) is left untouched — only
 * the `0`-`9` characters are swapped.
 *
 * Used to localize numeric displays (prices, counts, quantities) on the
 * Arabic storefront when a store opts into `StoreTheme.arabicNumerals`.
 * Never apply this to identifiers (order numbers, SKUs, phone numbers,
 * tracking numbers) — those must always stay Western digits.
 */
export function toArabicDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, digit => ARABIC_DIGITS[Number(digit)]);
}

/**
 * Canonical slug charset for this codebase: lowercase ASCII alphanumerics plus
 * the Arabic block, separated by `-`.
 *
 * This is not an arbitrary choice — it is the charset the server's own
 * validators already enforce:
 *   - `product.routes.ts`  slug regex  /^[a-z0-9\u0600-\u06FF-]+$/
 *   - `BulkService.generateSlug`        strips to [a-z0-9\u0600-\u06FF\s-]
 *
 * A wider charset (e.g. `\p{L}\p{N}`, which admits accents, Cyrillic and CJK)
 * makes the server mint slugs its own API then rejects with a 400 — a product
 * named "Café Noir" would persist `café-noir` and fail validation the moment any
 * client echoed it back on update.
 */
const SLUG_STRIP = /[^a-z0-9\u0600-\u06FF\s-]+/g;

/** Store slugs are stricter: ASCII only. See `slugifyWithFallback`. */
const SLUG_STRIP_ASCII = /[^a-z0-9\s-]+/g;

/**
 * Generate a URL-friendly slug from a string.
 *
 * Keeps the Arabic block, so an Arabic product name yields an Arabic slug
 * rather than an empty string (`\w` is ASCII-only, and stripping to it meant
 * every Arabic-only name slugified to ''). Product URLs already carry Arabic
 * slugs in production and the storefront encodes/decodes them symmetrically.
 *
 * CAN RETURN AN EMPTY STRING for input with no letters or digits in the
 * supported charset. Callers that persist a slug must use `slugifyWithFallback`.
 */
export function slugify(text: string, opts: { ascii?: boolean } = {}): string {
  return (text ?? '')
    .toLowerCase()
    .trim()
    .replace(opts.ascii ? SLUG_STRIP_ASCII : SLUG_STRIP, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `slugify` that is guaranteed to return a non-empty, URL-safe slug.
 *
 * Persisting an empty slug is never harmless: a product whose slug is '' is
 * unreachable (its URL collapses to the listing page), and a de-duplication
 * loop appending a counter to an empty base produces '-1', '-2', '-3' — which
 * is exactly what reached production on a live store (2026-09-02). Every
 * server-side path that WRITES a slug must use this, not bare `slugify`.
 *
 * PASS `ascii: true` FOR STORE SLUGS. A store slug is the path prefix on
 * platform hosts (`/<slug>/products/...`), and the storefront middleware reads
 * it from `nextUrl.pathname` — which is percent-encoded for non-ASCII — then
 * forwards it verbatim as the `x-store-slug` header. The by-slug lookup would
 * compare `%D9%84%D9%88%D8%B2` against `لوز` and never match, so a non-ASCII
 * store slug is unroutable. `store.routes.ts` enforces /^[a-z0-9-]+$/ for the
 * same reason. An Arabic-only store name therefore falls back to `store-<id>`
 * rather than minting a slug nothing can resolve.
 */
export function slugifyWithFallback(
  text: string,
  prefix = 'item',
  opts: { ascii?: boolean } = {}
): string {
  const base = slugify(text ?? '', opts);
  return base || `${prefix}-${Date.now().toString(36)}`;
}

/**
 * Generate cryptographically random string for IDs, tokens, etc.
 */
export function generateId(length = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // WebCrypto is available in every supported runtime (Node 18+, Edge,
  // browsers). The previous `require('crypto')` fallback was a leftover
  // for ancient Node and tripped @typescript-eslint/no-require-imports.
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
    throw new Error('generateId requires a runtime with WebCrypto (Node 18+, Edge, browser)');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b: number) => chars[b % chars.length]).join('');
}

/**
 * Delay execution
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safely parse JSON with fallback
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Omit keys from object
 */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  keys.forEach(key => delete result[key]);
  return result;
}

/**
 * Pick keys from object
 */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  keys.forEach(key => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
}

/**
 * Check if value is empty (null, undefined, empty string, empty array, empty object)
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Validate an email address.
 *
 * Uses a simple, widely-accepted pattern: no whitespace, exactly one `@`,
 * and at least one `.` in the domain part.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Truncate string to max length
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}
export { isHostInjectedScriptEvent } from './sentry-host-injected-filter';
