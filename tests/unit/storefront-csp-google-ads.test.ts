/**
 * #1201: the storefront CSP must admit the Google Ads conversion runtime.
 * gtag.js with an AW- config pulls conversion_async.js from
 * www.googleadservices.com and beacons to googleads.g.doubleclick.net /
 * www.google.com — a CSP that omits them lets the tag load and silently eats
 * every conversion. Read from the config text (PR tier, no network).
 */
import { describe, it, expect } from 'vitest';
import { buildStorefrontCsp } from '../../apps/web/src/lib/csp';

const csp = buildStorefrontCsp('AAAAAAAAAAAAAAAAAAAAAA==');
const directive = (name: string) => {
  const d = csp.split('; ').find(x => x.startsWith(`${name} `));
  expect(d, `${name} not found in the storefront CSP`).toBeDefined();
  return d!;
};

describe('storefront CSP — Google Ads', () => {
  it('script-src admits the Ads conversion runtime hosts', () => {
    const scriptSrc = directive('script-src');
    expect(scriptSrc).toContain('https://www.googleadservices.com');
    expect(scriptSrc).toContain('https://googleads.g.doubleclick.net');
  });

  it('connect-src admits the Ads conversion beacon hosts', () => {
    const connectSrc = directive('connect-src');
    for (const host of [
      'https://www.googleadservices.com',
      'https://googleads.g.doubleclick.net',
      'https://www.google.com',
    ]) {
      expect(connectSrc).toContain(host);
    }
  });
});
