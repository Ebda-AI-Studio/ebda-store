/**
 * #1201: the storefront CSP must admit the Google Ads conversion runtime.
 * gtag.js with an AW- config pulls conversion_async.js from
 * www.googleadservices.com and beacons to googleads.g.doubleclick.net /
 * www.google.com — a CSP that omits them lets the tag load and silently eats
 * every conversion. Read from the config text (PR tier, no network).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../apps/web/next.config.js'), 'utf8');
const directive = (name: string) => {
  const m = src.match(new RegExp(`"${name} [^"]*"`));
  expect(m, `${name} not found in apps/web/next.config.js`).not.toBeNull();
  return m![0];
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
