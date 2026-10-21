/**
 * Review M-1 (W2a fix round 1): the "Shop this look" page title follows the page locale (the
 * `force-language` cookie, else the store's default language), Arabic first, as the body does;
 * with no panel title it falls back to the store name in that language. Always noindex.
 */
import { describe, it, expect, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ locale: 'ar' as 'ar' | 'en', panel: null as unknown }));
vi.mock('../../apps/web/src/lib/store-resolver', () => ({
  getStore: async () => ({ id: 's1', name: 'Qamar', nameAr: 'قمر', settings: {} }),
  getStoreOrNotFound: async () => ({ id: 's1' }),
}));
vi.mock('../../apps/web/src/lib/seo/resolve-locale', () => ({
  resolveStorefrontLocale: async () => ctx.locale,
}));
vi.mock('../../apps/web/src/app/looks/[sectionId]/[blockId]/load-panel', () => ({
  loadPanel: async () => (ctx.panel ? { panel: ctx.panel, pieces: [] } : null),
}));
vi.mock('../../apps/web/src/app/looks/[sectionId]/[blockId]/LookPiecesClient', () => ({
  LookPiecesClient: () => null,
}));

const { generateMetadata } =
  await import('../../apps/web/src/app/looks/[sectionId]/[blockId]/page');
const params = Promise.resolve({ sectionId: 'stl', blockId: 'look-1' });

describe('look panel metadata', () => {
  it('Arabic page: the Arabic look title; English page: the English one', async () => {
    ctx.panel = { title: 'Linen in rose', titleAr: 'كتان وردي' };
    ctx.locale = 'ar';
    expect((await generateMetadata({ params })).title).toBe('كتان وردي');
    ctx.locale = 'en';
    expect((await generateMetadata({ params })).title).toBe('Linen in rose');
  });
  it('no panel title: the store name in the page language; always noindex', async () => {
    ctx.panel = { title: '', titleAr: '' };
    ctx.locale = 'ar';
    const meta = await generateMetadata({ params });
    expect(meta.title).toBe('قمر');
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
