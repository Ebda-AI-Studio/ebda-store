/**
 * Unit tests for `heroSlideSchema`'s new `link` field (the "banner link"
 * feature — docs/plans/2026-07-04-hero-banner-link.md).
 *
 * `link` mirrors the existing `ctaHref` field verbatim: same optional +
 * safe-URL-scheme-allowlist refine, listed directly in the Zod object (the
 * documented silent-strip trap — an unlisted key is dropped from a parsed
 * result even though the input had it).
 */
import { describe, it, expect } from 'vitest';
import { heroSlideSchema } from '../../apps/api/src/routes/store-layout.routes';

const baseSlide = { image: '/hero.jpg' };

describe('heroSlideSchema — link (banner link)', () => {
  it('accepts a slide with no link at all (field omitted)', () => {
    const result = heroSlideSchema.safeParse(baseSlide);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.link).toBeUndefined();
    }
  });

  it('accepts an empty string link (explicit "no banner link")', () => {
    const result = heroSlideSchema.safeParse({ ...baseSlide, link: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.link).toBe('');
    }
  });

  it('accepts a safe relative path', () => {
    const result = heroSlideSchema.safeParse({ ...baseSlide, link: '/products?category=shoes' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.link).toBe('/products?category=shoes');
    }
  });

  it('accepts a safe absolute https URL', () => {
    const result = heroSlideSchema.safeParse({
      ...baseSlide,
      link: 'https://demo-shop.example/sale',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URL', () => {
    const result = heroSlideSchema.safeParse({ ...baseSlide, link: 'javascript:alert(1)' });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URL', () => {
    const result = heroSlideSchema.safeParse({
      ...baseSlide,
      link: 'data:text/html,<script>alert(1)</script>',
    });
    expect(result.success).toBe(false);
  });

  it('does not silently strip `link` from a parsed slide (the documented trap)', () => {
    const result = heroSlideSchema.safeParse({ ...baseSlide, link: '/clearance' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('link' in result.data).toBe(true);
      expect(result.data.link).toBe('/clearance');
    }
  });

  it('still accepts an unrelated safe ctaHref alongside link (both sibling fields work)', () => {
    const result = heroSlideSchema.safeParse({
      ...baseSlide,
      ctaHref: '/products',
      link: 'https://demo-shop.example/sale',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ctaHref).toBe('/products');
      expect(result.data.link).toBe('https://demo-shop.example/sale');
    }
  });
});
