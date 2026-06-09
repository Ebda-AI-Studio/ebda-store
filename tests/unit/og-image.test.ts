import { describe, it, expect } from 'vitest';
import { resolveStoreOgImage, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT } from '@web/lib/seo/og-image';

const SITE_URL = 'https://example.com';
const ALT = 'Test Store';

describe('resolveStoreOgImage', () => {
  it('returns the raw https logo URL when present', () => {
    const logoUrl = 'https://pub-abc.r2.dev/stores/1/logo.png';
    const entry = resolveStoreOgImage(logoUrl, SITE_URL, ALT);
    expect(entry.url).toBe(logoUrl);
  });

  it('returns the raw https ogImage URL when present', () => {
    const ogUrl = 'https://pub-abc.r2.dev/stores/1/og.jpg';
    const entry = resolveStoreOgImage(ogUrl, SITE_URL, ALT);
    expect(entry.url).toBe(ogUrl);
  });

  it('falls back to /opengraph-image route when rawUrl is undefined', () => {
    const entry = resolveStoreOgImage(undefined, SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/opengraph-image`);
  });

  it('falls back to /opengraph-image route when rawUrl is null', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/opengraph-image`);
  });

  it('falls back to /opengraph-image route when rawUrl is empty string', () => {
    const entry = resolveStoreOgImage('', SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/opengraph-image`);
  });

  it('falls back to /opengraph-image route for relative URLs (WhatsApp rejects non-https)', () => {
    const entry = resolveStoreOgImage('/uploads/logo.png', SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/opengraph-image`);
  });

  it('falls back to /opengraph-image route for http URLs', () => {
    const entry = resolveStoreOgImage('http://insecure.example.com/logo.png', SITE_URL, ALT);
    expect(entry.url).toBe(`${SITE_URL}/opengraph-image`);
  });

  it('always returns OG_IMAGE_WIDTH = 1200 and OG_IMAGE_HEIGHT = 630', () => {
    const withLogo = resolveStoreOgImage('https://r2.dev/logo.png', SITE_URL, ALT);
    expect(withLogo.width).toBe(OG_IMAGE_WIDTH);
    expect(withLogo.height).toBe(OG_IMAGE_HEIGHT);

    const withFallback = resolveStoreOgImage(null, SITE_URL, ALT);
    expect(withFallback.width).toBe(OG_IMAGE_WIDTH);
    expect(withFallback.height).toBe(OG_IMAGE_HEIGHT);
  });

  it('always sets alt to the passed alt string', () => {
    const entry = resolveStoreOgImage(null, SITE_URL, ALT);
    expect(entry.alt).toBe(ALT);
  });

  it('og:image URL is always absolute https — never relative or empty', () => {
    const cases = [undefined, null, '', '/relative', 'http://not-https.com/img.png'];
    for (const raw of cases) {
      const entry = resolveStoreOgImage(raw, SITE_URL, ALT);
      expect(entry.url).toMatch(/^https:\/\//);
    }
  });
});
