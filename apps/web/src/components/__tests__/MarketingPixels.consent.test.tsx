// @vitest-environment jsdom
/**
 * Launch blocker 32 (SEARCH-T5-9 residual, Ruling PIXEL-CONSENT-1): no pixel request of any kind
 * before marketing consent, for every provider, and no pixel provider ever initialises on a URL
 * whose query carries a typed term, an email, a phone or a one-time token (the pixels read the
 * page URL themselves and send it to their network).
 *
 * "Request" here = a rendered pixel <script> (the only way a provider library or its first
 * PageView is loaded), a call into a provider global, a fetch, a beacon or an <img> ping.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { MarketingPixels } from '@ebda/shared';

vi.mock('next/script', () => ({
  __esModule: true,
  default: ({ id, src, children }: { id?: string; src?: string; children?: string }) =>
    React.createElement('script', { id, src, 'data-inline': children ?? '' }),
}));
let urlSearch = '';
let consentValue: { marketing: boolean } | null = null;
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(urlSearch),
}));
vi.mock('../../contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => true }),
}));
vi.mock('../../contexts/ConsentContext', () => ({
  useConsent: () => ({ consent: consentValue }),
}));

import {
  MarketingPixelsProvider,
  trackAddToCart,
  trackAddToWishlist,
  trackInitiateCheckout,
  trackLead,
  trackPurchase,
  trackSearch,
  trackViewContent,
} from '../MarketingPixels';

const ALL: MarketingPixels = {
  meta: { enabled: true, pixelId: '123456' },
  tiktok: { enabled: true, pixelId: 'TT123' },
  snapchat: { enabled: true, pixelId: 'SN123' },
  twitter: { enabled: true, pixelId: 'TW123' },
  pinterest: { enabled: true, tagId: 'PI123' },
  googleAnalytics: { enabled: true, measurementId: 'G-ABCDEF1234' },
  googleTagManager: { enabled: true, containerId: 'GTM-ABC1234' },
  googleAds: { enabled: true, conversionId: 'AW-123456789', conversionLabel: 'AbC123def' },
} as MarketingPixels;

const GLOBALS = ['fbq', 'ttq', 'snaptr', 'gtag', 'twq', 'pintrk'] as const;
let spies: Record<string, ReturnType<typeof vi.fn>>;
let net: ReturnType<typeof vi.fn>;

function installProviderGlobals() {
  spies = {};
  for (const g of GLOBALS) {
    spies[g] = vi.fn();
    (window as unknown as Record<string, unknown>)[g] =
      g === 'ttq' ? { page: spies[g], track: spies[g] } : spies[g];
  }
}
const providerCalls = () => Object.values(spies).reduce((n, s) => n + s.mock.calls.length, 0);

beforeEach(() => {
  urlSearch = '';
  consentValue = null;
  net = vi.fn();
  vi.stubGlobal('fetch', net);
  Object.defineProperty(navigator, 'sendBeacon', { value: net, configurable: true });
  installProviderGlobals();
});
afterEach(() => {
  cleanup();
  for (const g of GLOBALS) delete (window as unknown as Record<string, unknown>)[g];
  vi.unstubAllGlobals();
});

function mount() {
  const { container } = render(<MarketingPixelsProvider pixels={ALL} />);
  return [...container.querySelectorAll('script')].map(s => s.id);
}

function fireEveryEvent() {
  trackViewContent({ contentId: 'p', contentName: 'n' });
  trackAddToCart({ contentId: 'p', contentName: 'n' });
  trackInitiateCheckout({ contentIds: ['p'], numItems: 1, value: 1 });
  trackSearch({ searchString: 'shoes' });
  trackAddToWishlist({ contentId: 'p', contentName: 'n' });
  trackLead({ contentName: 'n' });
  return trackPurchase({ orderId: 'o', contentIds: ['p'], numItems: 1, value: 1 });
}

describe('no pixel traffic before marketing consent (every provider)', () => {
  for (const [label, consent] of [
    ['undecided (null)', null],
    ['rejected', { marketing: false }],
  ] as const) {
    it(`${label}: renders no provider script, calls no provider, makes no request`, () => {
      consentValue = consent;
      expect(mount()).toEqual([]);
      expect(providerCalls()).toBe(0);
      expect(net).not.toHaveBeenCalled();
    });

    it(`${label}: every track* helper is a no-op even if a provider global exists`, () => {
      consentValue = consent;
      mount();
      expect(fireEveryEvent()).toBe(false);
      expect(providerCalls()).toBe(0);
      expect(net).not.toHaveBeenCalled();
    });
  }

  it('control: with consent on a clean URL every provider loads and PageView fires', () => {
    consentValue = { marketing: true };
    const ids = mount();
    expect(ids).toEqual(
      expect.arrayContaining(['gtm', 'ga4', 'meta-pixel', 'tiktok-pixel', 'snapchat-pixel'])
    );
    expect(spies.fbq).toHaveBeenCalledWith('track', 'PageView');
    expect(fireEveryEvent()).toBe(true);
    expect(providerCalls()).toBeGreaterThan(5);
  });
});

describe('no pixel on a URL that carries a term, an email, a phone or a token', () => {
  it.each([
    '?q=01012345678',
    '?search=%D9%85%D9%86%D9%89',
    '?email=a%40b.com',
    '?phone=01012345678',
    '?token=abc123',
    '?restore=abc123',
    '?waToken=abc123',
  ])('consented, %s: no script, no PageView, no event', search => {
    consentValue = { marketing: true };
    urlSearch = search;
    expect(mount()).toEqual([]);
    expect(providerCalls()).toBe(0);
    expect(fireEveryEvent()).toBe(false);
    expect(providerCalls()).toBe(0);
    expect(net).not.toHaveBeenCalled();
  });

  it('a harmless query (sort, category, utm) does not switch the pixels off', () => {
    consentValue = { marketing: true };
    urlSearch = '?sort=newest&category=c1&utm_source=meta';
    expect(mount()).toContain('meta-pixel');
  });
});
