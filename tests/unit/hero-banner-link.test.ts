/**
 * Unit tests for `resolveBannerLink` — the decision logic behind
 * `HeroBannerLink` (docs/plans/done/2026-07-04-hero-banner-link.md).
 *
 * `HeroBannerLink` itself is a `.tsx` React component; this repo has no
 * jsdom/testing-library installed (vitest env = 'node', see
 * `tests/unit/governorate-area-select.test.tsx`), and `apps/web`'s
 * `tsconfig.json` sets `jsx: "preserve"` (required for Next's own
 * compiler), which esbuild/vite cannot transform on its own — attempting
 * to import/render a `.tsx` component under `apps/web` from vitest fails
 * at the transform step ("makes sure to not set jsx to preserve"). So the
 * resolver lives in `hero-banner-link-utils.ts`, a plain `.ts` module with
 * no JSX, and `HeroBannerLink.tsx` re-exports it for callers.
 *
 * `resolveBannerLink` is exported as a plain function specifically so the
 * render decision — anchor vs. no-anchor — is unit-testable without a DOM:
 * `HeroBannerLink` renders the stretched `<a>` iff `resolveBannerLink`
 * returns non-null, and renders `children` inside a bare Fragment (no
 * wrapper, zero DOM change) iff it returns `null`. These tests exercise
 * that boundary directly, plus the safe-URL scheme-allowlist reuse.
 */
import { describe, it, expect } from 'vitest';
import { resolveBannerLink } from '../../apps/web/src/templates/shared/hero-banner-link-utils';

describe('resolveBannerLink — HeroBannerLink render decision', () => {
  it('returns null for undefined (slide with no banner link) — renders Fragment/no anchor', () => {
    expect(resolveBannerLink(undefined)).toBeNull();
  });

  it('returns null for empty string (slide explicitly cleared) — renders Fragment/no anchor', () => {
    expect(resolveBannerLink('')).toBeNull();
  });

  it('returns the safe link for a relative path — renders an anchor', () => {
    expect(resolveBannerLink('/products')).toBe('/products');
  });

  it('returns the safe link for an absolute https URL — renders an anchor', () => {
    expect(resolveBannerLink('https://demo-shop.example/sale')).toBe(
      'https://demo-shop.example/sale'
    );
  });

  it('returns null for a javascript: URL (neutralized, defense-in-depth) — renders Fragment/no anchor', () => {
    expect(resolveBannerLink('javascript:alert(1)')).toBeNull();
  });

  it('returns null for a data: URL — renders Fragment/no anchor', () => {
    expect(resolveBannerLink('data:text/html,<script>alert(1)</script>')).toBeNull();
  });
});
