import { describe, it, expect } from 'vitest';
import { sanitizeThemeColor, sanitizeCssValue, buildThemeStyleTag } from '@web/lib/theme-css';

/**
 * Unit tests for the theme CSS sanitizers extracted from `app/layout.tsx`
 * during the tenant-cacheable routing Phase 1 work (see
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6). These are
 * security-sensitive (they sanitize merchant-supplied theme values before
 * they're injected into a raw `<style>` tag), so both trees (legacy
 * header-based layout + the new params-based `tenant-store` layout) must share
 * exactly one implementation — this suite pins that implementation's
 * behavior.
 */
describe('sanitizeThemeColor', () => {
  it('accepts a valid hex color', () => {
    expect(sanitizeThemeColor('#ff6e00')).toBe('#ff6e00');
  });

  it('accepts a valid HSL component string', () => {
    expect(sanitizeThemeColor('26 100% 50%')).toBe('26 100% 50%');
  });

  it('accepts an HSL string with alpha slash syntax', () => {
    expect(sanitizeThemeColor('26 100% 50% / 0.5')).toBe('26 100% 50% / 0.5');
  });

  it('falls back on a value containing braces (CSS injection attempt)', () => {
    expect(sanitizeThemeColor('red; } body { background: url(javascript:alert(1))')).toBe(
      '0 0% 0%'
    );
  });

  it('falls back on url(...)', () => {
    expect(sanitizeThemeColor('url(javascript:alert(1))')).toBe('0 0% 0%');
  });

  it('falls back on @import', () => {
    expect(sanitizeThemeColor('@import evil.css')).toBe('0 0% 0%');
  });

  it('falls back on an overlong value', () => {
    expect(sanitizeThemeColor('a'.repeat(51))).toBe('0 0% 0%');
  });

  it('uses the provided fallback', () => {
    expect(sanitizeThemeColor('not-a-color', '1 1% 1%')).toBe('1 1% 1%');
  });
});

describe('sanitizeCssValue', () => {
  it('accepts a rem value', () => {
    expect(sanitizeCssValue('0.5rem')).toBe('0.5rem');
  });

  it('accepts a var() reference', () => {
    expect(sanitizeCssValue('var(--font-sans)')).toBe('var(--font-sans)');
  });

  it('falls back on dangerous constructs', () => {
    expect(sanitizeCssValue('expression(alert(1))')).toBe('0');
  });

  it('falls back on disallowed characters', () => {
    expect(sanitizeCssValue('<script>')).toBe('0');
  });
});

describe('buildThemeStyleTag', () => {
  it('returns an empty string for a null/undefined theme', () => {
    expect(buildThemeStyleTag(null)).toBe('');
    expect(buildThemeStyleTag(undefined)).toBe('');
  });

  it('emits a :root rule with sanitized values', () => {
    const tag = buildThemeStyleTag({ primaryColor: '26 100% 50%' } as never);
    expect(tag.startsWith(':root {')).toBe(true);
    expect(tag).toContain('26 100% 50%');
  });
});
