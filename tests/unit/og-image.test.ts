import { describe, it, expect } from 'vitest';
import { resolveStoreOgImage, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT } from '@web/lib/seo/og-image';

const SITE_URL = 'https://example.com';
const ALT = 'Test Store';

const SLUG = 'demo-store';

describe('resolveStoreOgImage', () => {
  it('uses an explicit https RASTER ogImage URL verbatim', () => {
    const ogUrl = 'https://pub-abc.r2.dev/stores/1/og.jpg';
    const entry = resolveStoreOgImage(ogUrl, SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(ogUrl);
  });

  it('uses an explicit https PNG ogImage URL verbatim', () => {
    const ogUrl = 'https://pub-abc.r2.dev/stores/1/card.png';
    const entry = resolveStoreOgImage(ogUrl, SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(ogUrl);
  });

  it('does NOT use an SVG ogImage directly — Satori cannot <img> SVG, so the card rasterizes it', () => {
    const svg = 'https://pub-abc.r2.dev/stores/1/logo.svg';
    const entry = resolveStoreOgImage(svg, SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('falls back to the store-aware /og?slug card when ogImage is undefined', () => {
    const entry = resolveStoreOgImage(undefined, SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('falls back to the /og card when ogImage is null', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('falls back to the /og card when ogImage is an empty string', () => {
    const entry = resolveStoreOgImage('', SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('falls back to the /og card for relative URLs (WhatsApp rejects non-https)', () => {
    const entry = resolveStoreOgImage('/uploads/og.png', SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('falls back to the /og card for http URLs', () => {
    const entry = resolveStoreOgImage('http://insecure.example.com/og.png', SITE_URL, ALT, SLUG);
    expect(entry.url).toBe(`${SITE_URL}/og?slug=${SLUG}`);
  });

  it('omits the slug query when no slug is supplied (custom-domain stores resolve by host)', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/og`);
  });

  it('url-encodes the slug in the fallback card URL', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT, 'my store');
    expect(entry.url).toBe(`${SITE_URL}/og?slug=my%20store`);
  });

  it('always returns OG_IMAGE_WIDTH = 1200 and OG_IMAGE_HEIGHT = 630', () => {
    const withExplicit = resolveStoreOgImage('https://r2.dev/og.png', SITE_URL, ALT, SLUG);
    expect(withExplicit.width).toBe(OG_IMAGE_WIDTH);
    expect(withExplicit.height).toBe(OG_IMAGE_HEIGHT);

    const withFallback = resolveStoreOgImage(null, SITE_URL, ALT, SLUG);
    expect(withFallback.width).toBe(OG_IMAGE_WIDTH);
    expect(withFallback.height).toBe(OG_IMAGE_HEIGHT);
  });

  it('always sets alt to the passed alt string', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT, SLUG);
    expect(entry.alt).toBe(ALT);
  });

  it('og:image URL is always absolute https — never relative or empty', () => {
    const cases = [undefined, null, '', '/relative', 'http://not-https.com/img.png'];
    for (const raw of cases) {
      const entry = resolveStoreOgImage(raw, SITE_URL, ALT, SLUG);
      expect(entry.url).toMatch(/^https:\/\//);
    }
  });
});
