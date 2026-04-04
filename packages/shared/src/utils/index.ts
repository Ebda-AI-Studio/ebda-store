// Shared Utilities

// Export utility modules
export * from './image';
export * from './csv';

/**
 * Format a price value as a localised currency string.
 *
 * By default the input is in fils (1 KWD = 1000 fils) and the output uses
 * KWD with 3 decimal places.  Pass `{ unit: 'kwd' }` if the input is already
 * in the major currency unit.
 *
 * @param amount   - The price amount (in fils by default, or KWD if `unit` is `'kwd'`).
 * @param options  - Optional overrides for unit, currency, and locale.
 */
export function formatPrice(
  amount: number,
  options?: { unit?: 'fils' | 'kwd'; currency?: string; locale?: string }
): string {
  const { unit = 'fils', currency = 'KWD', locale = 'en-US' } = options ?? {};
  const decimals = currency === 'KWD' ? 3 : 2;
  const divisor = unit === 'fils' ? (currency === 'KWD' ? 1000 : 100) : 1;

  return new Intl.NumberFormat(locale, {
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
  const bytes =
    typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues
      ? globalThis.crypto.getRandomValues(new Uint8Array(length))
      : require('crypto').randomBytes(length);
  return Array.from(bytes as Uint8Array, (b: number) => chars[b % chars.length]).join('');
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
