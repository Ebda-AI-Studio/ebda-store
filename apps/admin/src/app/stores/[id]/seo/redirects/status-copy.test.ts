import { describe, expect, it } from 'vitest';
import ar from '@/i18n/messages/ar.json';
import en from '@/i18n/messages/en.json';

// The storefront answers a renamed slug with Next's permanentRedirect (308); the admin copy must not promise 301.
describe('slug redirect copy states the real status', () => {
  const pick = (m: unknown) =>
    (m as { seo: { page: { redirectsSubtitle: string } } }).seo.page.redirectsSubtitle;
  it.each([
    ['ar', ar],
    ['en', en],
  ])('%s says 308 and never 301', (_l, m) => {
    expect(pick(m)).toContain('308');
    expect(pick(m)).not.toContain('301');
  });
});
