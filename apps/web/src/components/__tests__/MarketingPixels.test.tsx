// @vitest-environment jsdom
/**
 * Google tag / Google Ads wiring in MarketingPixels (#1200, #1202, #1203, #1307).
 *
 * The defect class here is silent: a `gtag()` stub with no library behind it,
 * a config command gtm.js never reads, or a GA4 `purchase` event that Google
 * Ads never counts as a conversion. Nothing throws and nothing logs, so these
 * assertions are the only gate.
 *
 * `next/script` is replaced by a plain <script> so the rendered ids, srcs and
 * inline bodies can be read from the DOM in document order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import type { MarketingPixels } from '@ebda/shared';

vi.mock('next/script', () => ({
  __esModule: true,
  default: ({ id, src, children }: { id?: string; src?: string; children?: string }) =>
    React.createElement('script', { id, src, 'data-inline': children ?? '' }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => true }),
}));
vi.mock('../../contexts/ConsentContext', () => ({
  useConsent: () => ({ consent: { marketing: true } }),
}));

import { MarketingPixelsProvider, trackPurchase, trackSearch } from '../MarketingPixels';

const ADS = { enabled: true, conversionId: 'AW-123456789', conversionLabel: 'AbC123def' };
const GA4 = { enabled: true, measurementId: 'G-ABCDEF1234' };
const GTM = { enabled: true, containerId: 'GTM-ABC1234' };

function scripts(pixels: MarketingPixels) {
  const { container } = render(<MarketingPixelsProvider pixels={pixels} />);
  return [...container.querySelectorAll('script')].map(s => ({
    id: s.id,
    src: s.getAttribute('src') ?? '',
    inline: s.getAttribute('data-inline') ?? '',
  }));
}
const GTAG_LIB = 'https://www.googletagmanager.com/gtag/js';
const hasGtagLibrary = (list: ReturnType<typeof scripts>) =>
  list.some(s => s.src.startsWith(GTAG_LIB));

afterEach(() => {
  cleanup();
  delete (window as { gtag?: unknown }).gtag;
});

describe('Google Ads tag bootstrap', () => {
  it('Ads-only: loads the gtag library BEFORE the Ads config', () => {
    const list = scripts({ googleAds: ADS } as MarketingPixels);
    const lib = list.findIndex(s => s.id === 'gads-lib');
    const cfg = list.findIndex(s => s.id === 'gads-config');
    expect(lib).toBeGreaterThanOrEqual(0);
    expect(cfg).toBeGreaterThan(lib);
  });

  // #1203
  it('Ads + GTM: still loads the gtag library (gtm.js does not interpret gtag config)', () => {
    const list = scripts({ googleAds: ADS, googleTagManager: GTM } as MarketingPixels);
    expect(list.some(s => s.id === 'gads-lib')).toBe(true);
    expect(hasGtagLibrary(list)).toBe(true);
  });

  it('Ads + GA4: does not load a second copy of the same library', () => {
    const list = scripts({ googleAds: ADS, googleAnalytics: GA4 } as MarketingPixels);
    expect(list.some(s => s.id === 'gads-lib')).toBe(false);
    expect(hasGtagLibrary(list)).toBe(true);
  });

  it('every configuration that emits gads-config has a gtag library on the page', () => {
    const matrix = [
      { googleAds: ADS },
      { googleAds: ADS, googleAnalytics: GA4 },
      { googleAds: ADS, googleTagManager: GTM },
      { googleAds: ADS, googleAnalytics: GA4, googleTagManager: GTM },
    ] as MarketingPixels[];
    for (const pixels of matrix) {
      const list = scripts(pixels);
      expect(list.some(s => s.id === 'gads-config')).toBe(true);
      expect(hasGtagLibrary(list), JSON.stringify(Object.keys(pixels))).toBe(true);
      cleanup();
    }
  });

  // #1202
  it("the Ads config carries gtag('js', new Date()) like Google's documented snippet", () => {
    const cfg = scripts({ googleAds: ADS } as MarketingPixels).find(s => s.id === 'gads-config');
    expect(cfg?.inline).toContain("gtag('js',new Date())");
    expect(cfg?.inline).toContain("gtag('config','AW-123456789')");
  });
});

// #1200
describe('trackPurchase — Google Ads conversion event', () => {
  let gtag: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    // The helpers fire only while the consented provider is mounted (Ruling PIXEL-CONSENT-1).
    render(<MarketingPixelsProvider pixels={{} as MarketingPixels} />);
    gtag = vi.fn();
    (window as { gtag?: unknown }).gtag = gtag;
  });
  const purchase = { orderId: 'order-1', contentIds: ['p1'], numItems: 1, value: 12.5 };

  it('sends a conversion to AW-<id>/<label> when the merchant set a label', () => {
    scripts({ googleAds: ADS } as MarketingPixels);
    trackPurchase(purchase);
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', {
      send_to: 'AW-123456789/AbC123def',
      value: 12.5,
      currency: 'EGP',
      transaction_id: 'order-1',
    });
  });

  it('sends no conversion event without a label', () => {
    scripts({ googleAds: { ...ADS, conversionLabel: undefined } } as MarketingPixels);
    trackPurchase(purchase);
    expect(gtag.mock.calls.some(c => c[1] === 'conversion')).toBe(false);
  });

  it('rejects a label that is not a plain id (it lands in a script argument)', () => {
    scripts({ googleAds: { ...ADS, conversionLabel: "x'),alert(1)//" } } as MarketingPixels);
    trackPurchase(purchase);
    expect(gtag.mock.calls.some(c => c[1] === 'conversion')).toBe(false);
  });

  it('sends no conversion once the pixel component has unmounted', () => {
    scripts({ googleAds: ADS } as MarketingPixels);
    cleanup();
    trackPurchase(purchase);
    expect(gtag.mock.calls.some(c => c[1] === 'conversion')).toBe(false);
  });
});

// The success page marks an order "reported" only on `true` (#1346).
describe('trackPurchase — reports whether any pixel received the event', () => {
  const purchase = { orderId: 'order-1', contentIds: ['p1'], numItems: 1, value: 12.5 };
  beforeEach(() => {
    // The helpers fire only while the consented provider is mounted (Ruling PIXEL-CONSENT-1).
    render(<MarketingPixelsProvider pixels={{} as MarketingPixels} />);
    for (const g of ['fbq', 'gtag', 'ttq', 'snaptr', 'twq', 'pintrk']) {
      delete (window as unknown as Record<string, unknown>)[g];
    }
  });

  it('false when no pixel library is on the page, even with an Ads target set', () => {
    scripts({ googleAds: ADS } as MarketingPixels); // publishes googleAdsSendTo
    delete (window as { gtag?: unknown }).gtag;
    expect(trackPurchase(purchase)).toBe(false);
  });

  it.each(['fbq', 'gtag', 'snaptr', 'twq', 'pintrk'])('true when only %s is present', g => {
    (window as unknown as Record<string, unknown>)[g] = vi.fn();
    expect(trackPurchase(purchase)).toBe(true);
  });

  it('true when only ttq is present', () => {
    (window as { ttq?: unknown }).ttq = { track: vi.fn() };
    expect(trackPurchase(purchase)).toBe(true);
  });
});

describe('trackSearch — the term reaches an ad network only when it is not personal data (Ruling SEARCH-T5-9)', () => {
  type W = Record<string, unknown>;
  const KEYS = ['fbq', 'ttq', 'snaptr', 'gtag', 'twq', 'pintrk'] as const;
  let calls: Record<string, unknown[][]>;

  beforeEach(() => {
    // The helpers fire only while the consented provider is mounted (Ruling PIXEL-CONSENT-1).
    render(<MarketingPixelsProvider pixels={{} as MarketingPixels} />);
    calls = { fbq: [], ttq: [], snaptr: [], gtag: [], twq: [], pintrk: [] };
    const w = window as unknown as W;
    for (const k of ['fbq', 'snaptr', 'gtag', 'twq', 'pintrk']) {
      w[k] = (...args: unknown[]) => calls[k].push(args);
    }
    w.ttq = { track: (...args: unknown[]) => calls.ttq.push(args) };
  });
  afterEach(() => {
    for (const k of KEYS) delete (window as unknown as W)[k];
  });

  // [adapter, the call it must make for a product term, for a personal-data term]
  const ADAPTERS: Array<[string, (t: string) => unknown[], unknown[]]> = [
    ['Meta fbq', t => ['track', 'Search', { search_string: t }], ['track', 'Search', {}]],
    ['TikTok ttq', t => ['Search', { query: t }], ['Search', {}]],
    ['Snap snaptr', t => ['track', 'SEARCH', { search_string: t }], ['track', 'SEARCH', {}]],
    ['Google gtag', t => ['event', 'search', { search_term: t }], ['event', 'search', {}]],
    ['Pinterest pintrk', t => ['track', 'search', { search_query: t }], ['track', 'search', {}]],
  ];
  const keyOf = (name: string) => name.split(' ')[1];

  it.each(ADAPTERS)('%s: a product term is sent', (name, withTerm) => {
    trackSearch({ searchString: "كوتشي 3'ada2" });
    expect(calls[keyOf(name)]).toEqual([withTerm("كوتشي 3'ada2")]);
  });

  const PERSONAL = [
    '01012345678',
    '٠١٠١٢٣٤٥٦٧٨',
    "O'Brien 010 1234 5678",
    'buyer@example.com',
    'ORD-LX3K9A2-7F',
    'https://x.com/a',
  ];
  it.each(ADAPTERS)(
    '%s: a personal-data term fires the event WITHOUT the term',
    (name, _w, without) => {
      for (const term of PERSONAL) {
        calls[keyOf(name)] = [];
        trackSearch({ searchString: term });
        expect(calls[keyOf(name)]).toEqual([without]);
        expect(JSON.stringify(calls)).not.toContain(term);
      }
    }
  );

  it('X twq never carried a term', () => {
    trackSearch({ searchString: 'dress' });
    trackSearch({ searchString: '01012345678' });
    expect(calls.twq).toEqual([
      ['track', 'Search'],
      ['track', 'Search'],
    ]);
  });
});
