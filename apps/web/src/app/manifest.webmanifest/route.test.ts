import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `/manifest.webmanifest` is a hand-written route since Ruling PWA-MANIFEST-2 (the `app/manifest.ts` file
 * convention cannot link a manifest per language). Its answer on the bare URL must not change: the same
 * bytes Next produced from the file convention (`JSON.stringify` of the object) and the same two headers.
 */

const built = { current: {} as Record<string, unknown> };
vi.mock('../../lib/pwa/store-manifest', () => ({
  buildStoreManifest: async () => built.current,
}));

const { GET } = await import('./route');

afterEach(() => {
  built.current = {};
});

describe('/manifest.webmanifest route', () => {
  it('answers the built manifest as plain JSON.stringify, key order kept', async () => {
    built.current = {
      name: 'قمر',
      short_name: 'قمر',
      description: 'بوتيك مصري توضيحي',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#141414',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '{"name":"قمر","short_name":"قمر","description":"بوتيك مصري توضيحي","start_url":"/","display":"standalone","background_color":"#ffffff","theme_color":"#141414","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"}]}'
    );
  });

  it('keeps the content type and cache policy the file convention sent', async () => {
    const res = await GET();
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('there is no app/manifest.ts: it would override the per-language link of every page', () => {
    const appDir = join(__dirname, '..');
    for (const name of ['manifest.ts', 'manifest.tsx', 'manifest.js', 'manifest.json'])
      expect(existsSync(join(appDir, name)), name).toBe(false);
    // The layout is the only thing that links the manifest now; it has to name it.
    expect(readFileSync(join(appDir, 'layout.tsx'), 'utf8')).toContain('manifestHref(');
  });
});
