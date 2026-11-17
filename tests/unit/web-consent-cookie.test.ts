import { describe, it, expect, afterEach } from 'vitest';
import { readMarketingConsentFromCookie } from '@web/lib/consent-cookie';

/**
 * Unit tests for the cookie-parsing helper backing `ConsentGatedMarketingPixels`
 * (tenant-cacheable routing Phase 1, dormant — see
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6). No jsdom/
 * testing-library in this repo, so this suite stubs `document.cookie` (a
 * getter) directly rather than rendering the component — the component
 * itself is a thin `useEffect` wrapper with no logic of its own to test.
 */
function stubCookie(value: string) {
  Object.defineProperty(globalThis, 'document', {
    value: { cookie: value },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('readMarketingConsentFromCookie', () => {
  it('returns false when document is undefined (SSR)', () => {
    Reflect.deleteProperty(globalThis, 'document');
    expect(readMarketingConsentFromCookie()).toBe(false);
  });

  it('returns false when the cookie is absent', () => {
    stubCookie('other=1');
    expect(readMarketingConsentFromCookie()).toBe(false);
  });

  it('returns true for a valid, consented cookie', () => {
    const value = encodeURIComponent(JSON.stringify({ marketing: true, v: 1, ts: '2026-01-01' }));
    stubCookie(`force-cookie-consent=${value}`);
    expect(readMarketingConsentFromCookie()).toBe(true);
  });

  it('returns false when marketing is false', () => {
    const value = encodeURIComponent(JSON.stringify({ marketing: false, v: 1, ts: '2026-01-01' }));
    stubCookie(`force-cookie-consent=${value}`);
    expect(readMarketingConsentFromCookie()).toBe(false);
  });

  it('returns false for a malformed cookie value', () => {
    stubCookie('force-cookie-consent=not-json');
    expect(readMarketingConsentFromCookie()).toBe(false);
  });

  it('returns false for an unversioned (legacy) cookie shape', () => {
    const value = encodeURIComponent(JSON.stringify({ marketing: true }));
    stubCookie(`force-cookie-consent=${value}`);
    expect(readMarketingConsentFromCookie()).toBe(false);
  });
});
