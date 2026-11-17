// Shared Utilities

import { REGION, roundToMinor, formatMoney, type Numerals } from '../region';

// Export utility modules
export * from './platform';
export * from './discount';
export * from './minimum-order';
export * from './accounting';
export * from './image';
export * from './csv';
export * from './plural';
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
  INVERSE_SURFACE,
  footerLogoContrastFilter,
  colorToHslTriplet,
  rgbToHslTriplet,
  hexToHsl,
  hslToHex,
} from './color';
export type { ColorValue, ColorToken, Rgb } from './color';
export {
  lightenColor,
  darkenColor,
  generateSectionPalette,
  deriveCoreBrandTokens,
  boundaryColorFloor,
} from './color';
export type {
  PaletteSeeds,
  SectionPaletteEntry,
  SectionKey,
  PalettePattern,
  CoreBrandTokens,
} from './color';
// Brand engine — palette → contrast-safe storefront CSS vars
export { deriveBrandRoles } from './brand-roles';
// Storefront status-message ink (issue 2349) — readable per store, legacy pass-through
export {
  STATUS_INK_ROLES,
  STATUS_INK_TINTS,
  STATUS_INK_MIN_CONTRAST,
  STATUS_ROLE_DEFAULTS,
  LEGACY_STATUS_INK_VALUE,
  deriveStatusInk,
  statusInkVars,
} from './status-ink';
export type { StatusInkRole } from './status-ink';
// URL-scheme safety (XSS guard for merchant-supplied link fields)
export { isSafeUrl, sanitizeUrl, safeInternalPath } from './safe-url';

/**
 * Format a price value as a localised currency string.
 *
 * By default the input is in MINOR units (EGP piastres, 1 EGP = 100 piastres).
 * Pass `{ unit: 'major' }` if the input is already in the major currency unit.
 * Delegates to `formatMoney` (region/index.ts) — the single formatter.
 *
 * `locale` defaults to `'en'` (`EGP 1,299.50`, `EGP 450`). `locale: 'ar'`
 * renders `1,299.50 ج.م` / `450 ج.م` with WESTERN digits, always (Ruling DIGITS-1;
 * `numerals` is accepted and ignored). A whole amount drops its zero fraction.
 *
 * @param amount   - The price amount (minor units by default, major if `unit` is `'major'`).
 * @param options  - Optional overrides for unit, currency, locale and digits.
 */
export function formatPrice(
  amount: number,
  options?: {
    unit?: 'minor' | 'major';
    currency?: string;
    locale?: 'en' | 'ar';
    /** Ignored: Western digits only (Ruling DIGITS-1). */
    numerals?: Numerals;
    /** Keep every decimal on whole amounts (`EGP 450.00`) — merchant/accounting surfaces. */
    fixedDecimals?: boolean;
  }
): string {
  const {
    unit = 'minor',
    currency = REGION.currency,
    locale = 'en',
    numerals,
    fixedDecimals,
  } = options ?? {};
  const minor = unit === 'minor' ? amount : roundToMinor(amount, currency);
  return formatMoney(minor, locale, { currency, numerals: numerals ?? 'latn', fixedDecimals });
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
export interface SlugifyOptions {
  ascii?: boolean;
  /** Cut to this many characters (no trailing hyphen after the cut). */
  max?: number;
  /** Live typing: keep one trailing hyphen so "a-" can become "a-b" (the blog field could not take a hyphen). Clean on submit. */
  keepTrailingHyphen?: boolean;
}

export function slugify(text: string, opts: SlugifyOptions = {}): string {
  const cut = (text ?? '')
    .toLowerCase()
    .trim()
    .replace(opts.ascii ? SLUG_STRIP_ASCII : SLUG_STRIP, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+/, '');
  const sized = opts.max ? cut.slice(0, opts.max) : cut;
  return opts.keepTrailingHyphen ? sized : sized.replace(/-+$/g, '');
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
 * PASS `ascii: true` FOR STORE SLUGS. A store slug is the host label of the
 * store's free address (`<slug>.ebda.app`), and DNS labels are ASCII (letters,
 * digits, hyphen): a non-ASCII slug is unroutable. `parseStoreHost` and the
 * slug validation in `./hosts` enforce `[a-z0-9-]` for the same reason. An
 * Arabic-only store name therefore falls back to `store-<id>` rather than
 * minting a slug nothing can resolve. (Reserved labels and the 3-40 length
 * rules are applied on top by `validateStoreSlug`.)
 */
export function slugifyWithFallback(
  text: string,
  prefix = 'item',
  opts: SlugifyOptions = {}
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
export {
  redactSensitiveQuery,
  redactPathSecrets,
  urlCarriesSensitiveQuery,
  scrubSentryEvent,
  scrubSentryBreadcrumb,
  scrubPostHogCapture,
  SENSITIVE_QUERY_PARAMS,
  REDACTED_QUERY_VALUE,
} from './sentry-url-scrub';
export { newCspNonce, isValidCspNonce, nonceScriptSrc } from './csp-nonce';

export { isEbdaMediaUrl, EBDA_MEDIA_HOSTS } from './media-url';
export {
  resolveColorForMeasure,
  contrastRatioOrNull,
  readVerdict,
  colorToHex,
} from './color-measure';
export type { ReadVerdict } from './color-measure';
