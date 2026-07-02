// Shared Utilities

// Export utility modules
export * from './platform';
export * from './discount';
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
export { isSafeUrl, sanitizeUrl } from './safe-url';

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

/**
 * Generate URL-friendly slug from string
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
