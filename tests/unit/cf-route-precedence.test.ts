/**
 * M-072: merchant custom domains (Cloudflare for SaaS) need the storefront Worker to receive requests for ANY hostname, so
 * ebda-web gets a `star/star` zone route. That is only safe if every other hostname in the zone has an explicit route that out-ranks
 * it. This proves it for the real route set (generated web routes, the committed wrangler configs, and the dashboard-only media
 * exclusion), using a model of Cloudflare's documented precedence (scripts/ci/cf-route-resolve.mjs).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { patternToRegex, resolve, specificity } from '../../scripts/ci/cf-route-resolve.mjs';
import { BRAND } from '../../packages/shared/src/brand';

const ROOT = path.resolve(__dirname, '../..');
type Route = { pattern: string; worker: string | null };

function wranglerRoutes(app: string, worker: string): Route[] {
  const raw = readFileSync(path.join(ROOT, 'apps', app, 'wrangler.jsonc'), 'utf8').replace(
    /\/\/[^\n]*/g,
    ''
  );
  const m = /"routes"\s*:\s*\[([\s\S]*?)\n?\s*\]\s*,/.exec(raw);
  if (!m) return [];
  // Zone routes only (those with zone_name). Custom Domain entries are deliberately NOT counted: scripts/cf-routes.cjs records that
  // a wildcard zone route is evaluated BEFORE custom domains, so a host protected only by a custom domain is not protected.
  return [...m[1].matchAll(/\{[^}]*\}/g)]
    .map(o => o[0])
    .filter(o => /"zone_name"/.test(o))
    .map(o => ({ pattern: /"pattern"\s*:\s*"([^"]+)"/.exec(o)![1], worker }));
}

/** The web routes exactly as scripts/cf-routes.cjs generates them (admin/orders are generated the same way). */
function generated(app: 'web' | 'admin' | 'orders', worker: string): Route[] {
  const dist = path.join(ROOT, 'packages/shared/dist/brand/index.js');
  const out = execFileSync(
    'node',
    [
      '-e',
      `
    const Module = require('module'); const orig = Module._load;
    Module._load = function (r, ...a) { if (r.endsWith('brand/index.js')) return { BRAND: ${JSON.stringify(BRAND)} }; return orig.call(this, r, ...a); };
    process.argv[2] = ${JSON.stringify(app)}; require(${JSON.stringify(path.join(ROOT, 'scripts/cf-routes.cjs'))});
  `,
    ],
    { encoding: 'utf8', cwd: ROOT }
  );
  void dist;
  const arr = JSON.parse('{' + out.trim().replace(/,$/, '') + '}').routes as {
    pattern: string;
    zone_name?: string;
  }[];
  return arr.filter(r => 'zone_name' in r).map(r => ({ pattern: r.pattern, worker }));
}

// dashboard/API-only, not in the repo: docs/DEPLOYMENT.md "Storefront wildcard" - media.ebda.app is R2 behind a Worker-less route
const MEDIA_EXCLUSION: Route = { pattern: 'media.ebda.app/*', worker: null };

const ROUTES: Route[] = [
  ...generated('web', 'ebda-web'),
  ...generated('admin', 'ebda-admin'),
  ...generated('orders', 'ebda-orders'),
  ...wranglerRoutes('marketing', 'ebda-marketing'),
  ...wranglerRoutes('accounts', 'ebda-accounts'),
  ...wranglerRoutes('api', 'ebda-api'),
  ...wranglerRoutes('docs', 'ebda-docs'),
  ...wranglerRoutes('help', 'ebda-help'),
  ...wranglerRoutes('status', 'ebda-status'),
  MEDIA_EXCLUSION,
].filter(r => !r.pattern.startsWith('http'));
const who = (url: string) => (resolve(url, ROUTES) as { worker: string | null } | null)?.worker;

describe('Cloudflare route precedence with the storefront */* route (M-072)', () => {
  it('the storefront has the */* route (otherwise this test proves nothing)', () => {
    expect(ROUTES).toContainEqual({ pattern: '*/*', worker: 'ebda-web' });
  });
  it.each([
    ['https://ebda.app/', 'ebda-marketing'],
    ['https://ebda.app/en/pricing', 'ebda-marketing'],
    ['https://ebda.app/.well-known/security.txt', 'ebda-marketing'],
    ['https://accounts.ebda.app/health', 'ebda-accounts'],
    ['https://api.ebda.app/health', 'ebda-api'],
    ['https://api.ebda.app/api/v1/public/stores/x', 'ebda-api'],
    ['https://store.ebda.app/login', 'ebda-admin'],
    ['https://orders.ebda.app/', 'ebda-orders'],
    ['https://docs.ebda.app/', 'ebda-docs'],
    ['https://help.ebda.app/', 'ebda-help'],
    ['https://status.ebda.app/en', 'ebda-status'],
    ['https://media.ebda.app/logo.png', null], // Worker-less exclusion still wins: R2 serves it
  ])('%s -> %s (explicit route out-ranks */*)', (url, worker) => {
    expect(who(url)).toBe(worker);
  });
  it.each([
    'https://storedemo-souq.ebda.app/',
    'https://my-shop.ebda.app/products',
    'https://cf.ebda.app/',
  ])('%s -> ebda-web (store subdomains unchanged)', url => expect(who(url)).toBe('ebda-web'));
  it.each([
    'https://shop.merchant-example.com/',
    'https://www.another-merchant.net/products/1?x=1',
    'https://merchant.co.uk/',
  ])('%s (a merchant custom domain) -> ebda-web via */*', url => expect(who(url)).toBe('ebda-web'));

  it('every zone host named anywhere in the repo is covered by a route that is not */*', () => {
    const hosts = Object.values(BRAND.domains).filter(
      (d): d is string =>
        typeof d === 'string' &&
        /^[a-z0-9.-]+\.[a-z]+$/.test(d) &&
        d.endsWith('ebda.app') &&
        !d.startsWith('.')
    );
    expect(hosts.length).toBeGreaterThan(4);
    for (const h of hosts) {
      const win = resolve(`https://${h}/`, ROUTES) as { pattern: string } | null;
      expect(win, `${h} has no route`).not.toBeNull();
      // a storefront-served host is fine; anything else must not be won by the catch-all
      if (!/^(storedemo|cf)/.test(h))
        expect(win!.pattern, `${h} is only served by ${win!.pattern}`).not.toBe('*/*');
    }
  });

  it('the model reproduces the two documented examples', () => {
    const r = (p: string) => ({ pattern: p, worker: p });
    expect(
      (resolve('https://www.example.com/', [r('*.example.com/*'), r('www.example.com/*')]) as Route)
        .pattern
    ).toBe('www.example.com/*');
    expect(
      (
        resolve('https://example.com/hello/world', [
          r('example.com/*'),
          r('example.com/hello/*'),
        ]) as Route
      ).pattern
    ).toBe('example.com/hello/*');
  });
  it('the model: *.example.com/* does not match the apex; *example.com/* does', () => {
    expect(patternToRegex('*.example.com/*').test('example.com/')).toBe(false);
    expect(patternToRegex('*example.com/*').test('example.com/')).toBe(true);
    expect(specificity('*/*')).toEqual([0, 1]);
  });

  it('MUTATION: without the explicit apex route the catch-all WOULD steal ebda.app', () => {
    const without = ROUTES.filter(
      r => !(r.worker === 'ebda-marketing' && r.pattern === 'ebda.app/*')
    );
    expect((resolve('https://ebda.app/', without) as Route).worker).toBe('ebda-web');
  });
  it('MUTATION: without the accounts route the catch-all WOULD steal accounts.ebda.app', () => {
    const without = ROUTES.filter(r => r.pattern !== 'accounts.ebda.app/*');
    expect((resolve('https://accounts.ebda.app/', without) as Route).worker).toBe('ebda-web');
  });
});
