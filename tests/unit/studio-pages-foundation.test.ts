import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HSTS_VALUE,
  pickStudioLang,
  renderStudioPage,
  STUDIO_COMING_SOON_LABELS,
  STUDIO_PAGE_HEADERS,
  STUDIO_REDIRECT_LABELS,
  studioHostPlan,
} from '../../packages/shared/src/studio-pages';

/**
 * F8: the studio-pages renderer moved to the foundation (`createStudioPages(BRAND, brandMarkSvg)`). These hashes were taken from the Store's
 * previous in-repo renderer on main BEFORE the swap, so a pass proves the output is byte-for-byte what ebda.app served until now.
 * (The footer year is pinned by the fake clock.)
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const PAGES = [
  ['ar', 'not-found', undefined],
  ['en', 'not-found', undefined],
  ['ar', 'coming-soon', 'crm'],
  ['en', 'coming-soon', 'crm'],
  ['ar', 'coming-soon', 'erp'],
  ['en', 'coming-soon', 'erp'],
  ['ar', 'coming-soon', 'reserved'],
  ['en', 'coming-soon', 'reserved'],
] as const;
const GOLDEN: Record<string, string> = {
  'ar/not-found/-': '907c1f7816b5062a82df833ed5f81a715ed6abb721c94547b95a80da8386fcbb',
  'en/not-found/-': '51bc3df5ebc0d44e9b39f1939a3a328e30eacb4e6b511364530b46752c0123f2',
  'ar/coming-soon/crm': '86ed6e00bead0278f0cd0966ab373abdc222dc21cb14e412391fa83374f1c712',
  'en/coming-soon/crm': '23c16d703a54beacd925680f879be82e3cbbfae2c9c8ef98dddf258ea12a0d8e',
  'ar/coming-soon/erp': 'c839d3e021a83bb2666d07c0a991ccf5db133bb98fcbfcc3ea10aad53789747f',
  'en/coming-soon/erp': 'c994c196d19e71acfd30fa9fe159ead30197fa305d01e7bc9c4c499b4bb29399',
  'ar/coming-soon/reserved': '64f52fa5735282987043dc260174d053396bd852d60e46cf8467dba3125e8b51',
  'en/coming-soon/reserved': '458711d0a444302e59dbcc46dc894296ef2bb2025eeb9a70d916c379404e77dd',
  headers: 'f400e35097625fbd808ac1dc5a36754ae7503c4d2494c31df2b63424bceabc34',
  labels: 'ef7f3c17c10b80776e17549bf1c1689a5f59e52bde43e87225e60821e09b9f69',
  plans: '86e714640179e37d87f8f0cb373b3a295b379cba463982f521e033619a3d64b4',
};

describe('studio pages: byte-identical to the pre-foundation renderer', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
  });
  afterAll(() => vi.useRealTimers());
  it.each(PAGES)('%s %s %s', (lang, kind, product) => {
    const key = `${lang}/${kind}/${product ?? '-'}`;
    const hash = sha(renderStudioPage({ lang, kind, product }));
    expect(hash, key).toBe(GOLDEN[key] ?? `UNSET ${key}`);
  });
  it('headers, labels and host plans', () => {
    expect(sha(JSON.stringify(STUDIO_PAGE_HEADERS))).toBe(GOLDEN['headers']!);
    expect(HSTS_VALUE).toBe('max-age=31536000; includeSubDomains; preload');
    expect(sha(JSON.stringify([STUDIO_COMING_SOON_LABELS, STUDIO_REDIRECT_LABELS]))).toBe(
      GOLDEN['labels']!
    );
    const plans = ['crm', 'ERP ', 'hub', 'whatsapp', 'chat', 'wa', 'zzz', 'quote-studio'].map(
      studioHostPlan
    );
    expect(sha(JSON.stringify(plans))).toBe(GOLDEN['plans']!);
    expect([
      pickStudioLang('en-US'),
      pickStudioLang('ar'),
      pickStudioLang(null),
      pickStudioLang('fr', 'en'),
    ]).toEqual(['en', 'ar', 'ar', 'en']);
  });
});
