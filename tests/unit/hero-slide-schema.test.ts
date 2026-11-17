/**
 * Unit tests for `heroSlideSchema`'s new `link` field (the "banner link"
 * feature — docs/plans/done/2026-07-04-hero-banner-link.md).
 *
 * `link` mirrors the existing `ctaHref` field verbatim: same optional +
 * safe-URL-scheme-allowlist refine, listed directly in the Zod object (the
 * documented silent-strip trap — an unlisted key is dropped from a parsed
 * result even though the input had it).
 */
import { describe, it, expect } from 'vitest';
import { heroSlideSchema } from '../../apps/api/src/routes/store-layout.routes';

const baseSlide = { image: '/hero.jpg' };

describe('heroSlideSchema — optional image (draft autosave must not block)', () => {
  // Bug: "A hero slide's autosave is blocked when it has no image." A newly
  // added slide starts with `settings: {}` (no `image` key at all) — the
  // whole-document draft validation must accept that so autosave can
  // persist the in-progress edit. Publish readiness is a SEPARATE, later
  // gate (`validatePublishReadiness`).
  it('accepts a slide with no image at all (field omitted — a freshly added slide)', () => {
    const result = heroSlideSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts an explicit empty-string image', () => {
    const result = heroSlideSchema.safeParse({ image: '' });
    expect(result.success).toBe(true);
  });

  it('still accepts a real image value', () => {
    const result = heroSlideSchema.safeParse(baseSlide);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.image).toBe('/hero.jpg');
  });
});

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

describe('heroSlideSchema — video / videoMobile (hero video)', () => {
  it('round-trips an https video and a relative mobile video unchanged', () => {
    const slide = {
      ...baseSlide,
      video: 'https://media.ebda.app/s/a.mp4',
      videoMobile: '/uploads/a-m.mp4',
    };
    const result = heroSlideSchema.safeParse(slide);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.video).toBe('https://media.ebda.app/s/a.mp4');
      expect(result.data.videoMobile).toBe('/uploads/a-m.mp4');
    }
  });

  it('accepts omitted and cleared (empty string) video', () => {
    expect(heroSlideSchema.safeParse(baseSlide).success).toBe(true);
    expect(heroSlideSchema.safeParse({ ...baseSlide, video: '', videoMobile: '' }).success).toBe(
      true
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'http://x.r2.dev/a.mp4',
    'mailto:a@b.co',
    'tel:+20100',
    'blob:https://x/1',
    'example.com/a.mp4',
  ])('rejects video %s', bad => {
    expect(heroSlideSchema.safeParse({ ...baseSlide, video: bad }).success).toBe(false);
    expect(heroSlideSchema.safeParse({ ...baseSlide, videoMobile: bad }).success).toBe(false);
  });
});
