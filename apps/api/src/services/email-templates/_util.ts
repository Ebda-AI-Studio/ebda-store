/**
 * HTML escape for safe interpolation of user-controlled strings in email templates.
 * Mirrors the escapeHtml function in email.service.ts — kept here to avoid a
 * circular dependency when template files import from this util.
 *
 * `&` must come first so the subsequent replacements don't double-encode it.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
