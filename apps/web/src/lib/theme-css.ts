import { themeToCssVars, type StoreTheme } from '@force/shared';

/**
 * Theme color/CSS-variable sanitizers + the `:root { ... }` style-tag
 * builder, extracted 2026-07-12 from `app/layout.tsx` (verbatim logic move,
 * zero behavior change) so the new tenant-cacheable Track-A layout
 * (`app/tenant-store/[tenant]/[locale]/layout.tsx`) can inject the identical theme
 * CSS without duplicating security-sensitive sanitization logic in two
 * places. See `docs/plans/2026-07-12-tenant-cacheable-routing.md` §3.6.
 */

/**
 * Sanitize a theme color value to prevent CSS injection.
 *
 * Theme colors from the database are HSL component strings (e.g. "26 100% 50%")
 * or hex colors (e.g. "#ff6e00"). This function validates the value matches one
 * of those safe formats and strips any dangerous CSS content that could escape
 * the declaration context.
 *
 * Returns `fallback` if the value does not pass validation.
 */
export function sanitizeThemeColor(value: string, fallback = '0 0% 0%'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 50) {
    return fallback;
  }

  // Block dangerous CSS constructs that could break out of a declaration
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }

  // Hex color: #RGB, #RRGGBB, or #RRGGBBAA (3-8 hex digits)
  const hexPattern = /^#[0-9a-fA-F]{3,8}$/;
  if (hexPattern.test(value)) {
    return value;
  }

  // HSL components: e.g. "26 100% 50%", "0 0% 100%", "220 14% 96%"
  // Allows optional decimal points and the slash syntax for alpha (e.g. "26 100% 50% / 0.5")
  const hslPattern =
    /^[0-9]+(?:\.[0-9]+)?\s+[0-9]+(?:\.[0-9]+)?%\s+[0-9]+(?:\.[0-9]+)?%(?:\s*\/\s*[0-9]+(?:\.[0-9]+)?%?)?$/;
  if (hslPattern.test(value)) {
    return value;
  }

  return fallback;
}

/**
 * Sanitize a non-color CSS custom property value (e.g. --radius, --font-family).
 * Allows rem/px units, var() references, and simple keyword values.
 */
export function sanitizeCssValue(value: string, fallback = '0'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    return fallback;
  }
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }
  // Allow: digits, letters, spaces, %, #, dots, parens (for var()), slashes, hyphens, commas
  const allowed = /^[a-zA-Z0-9\s%#.,()\/\-]+$/;
  if (!allowed.test(value)) {
    return fallback;
  }
  return value;
}

const NON_COLOR_VARS = new Set(['--radius', '--font-family']);

/**
 * Builds the `:root { --var: value; ... }` style-tag body from a store's
 * theme, sanitizing every value. Returns `''` when there's no theme to emit.
 * Shared by `app/layout.tsx` (legacy, header-based tree) and
 * `app/tenant-store/[tenant]/[locale]/layout.tsx` (new, params-based Track-A tree)
 * so both trees paint an identical theme.
 */
export function buildThemeStyleTag(
  theme: StoreTheme | Record<string, unknown> | null | undefined
): string {
  const themeCssVars = theme ? themeToCssVars(theme as StoreTheme) : null;
  if (!themeCssVars) return '';
  return `:root { ${Object.entries(themeCssVars)
    .map(([k, v]) => {
      const sanitized = NON_COLOR_VARS.has(k) ? sanitizeCssValue(v) : sanitizeThemeColor(v);
      return `${k}: ${sanitized}`;
    })
    .join('; ')} }`;
}
