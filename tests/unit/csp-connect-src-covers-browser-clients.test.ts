/**
 * Ruling CSP-ACCOUNTS-1: every absolute origin an app's BROWSER code fetches must be in that app's `connect-src`, or the
 * browser blocks the call and the user sees a bare "Failed to fetch". Admin and orders signed in against
 * accounts.ebda.app for days with no accounts origin in connect-src (accounts clients: #216, 2026-10-28).
 *
 * How it knows what a browser client calls: each NEXT_PUBLIC_*_URL/ORIGIN/HOST env var an app reads is the base of a
 * browser request. Every such variable must be in ORIGIN_OF (its production origin, or null with a reason when it is
 * never fetched from the browser), so a NEW client base fails here until someone decides, instead of failing silently
 * in production. Each app's connect-src, built by its real CSP builder, must contain every origin it uses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildAdminCsp } from '../../apps/admin/src/lib/csp';
import { buildOrdersCsp } from '../../apps/orders/src/lib/csp';
import { buildStorefrontCsp } from '../../apps/web/src/lib/csp';

const ROOT = path.resolve(__dirname, '../..');
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

/** env var -> the production origin the browser fetches, or null (never fetched from the browser). */
const ORIGIN_OF: Record<string, string | null> = {
  NEXT_PUBLIC_API_URL: 'https://api.ebda.app',
  NEXT_PUBLIC_ACCOUNTS_URL: 'https://accounts.ebda.app',
  NEXT_PUBLIC_MEDIA_ORIGIN: 'https://media.ebda.app',
  NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
  NEXT_PUBLIC_SITE_URL: null, // canonical / OG links, rendered into HTML, never fetched by the browser
};

const APPS: Record<string, string> = {
  admin: buildAdminCsp({ nonce: NONCE, pathname: '/', apiOrigin: 'https://api.ebda.app' }),
  orders: buildOrdersCsp(NONCE),
  web: buildStorefrontCsp(NONCE),
};

function* files(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) {
      if (['node_modules', '__tests__', 'test', '.next', '.open-next'].includes(n)) continue;
      yield* files(p);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.(ts|tsx)$/.test(n)) yield p;
  }
}

const connectSrc = (csp: string) =>
  csp
    .split('; ')
    .find(d => d.startsWith('connect-src '))!
    .split(' ')
    .slice(1);

const envBases = (app: string): string[] => {
  const found = new Set<string>();
  for (const f of files(path.join(ROOT, 'apps', app, 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(
      /\b(NEXT_PUBLIC_\w*(?:URL|ORIGIN|HOST|DOMAIN|ENDPOINT)\w*)/g
    ))
      found.add(m[1]);
  }
  return [...found].sort();
};

describe('connect-src names every origin the app browser code fetches (CSP-ACCOUNTS-1)', () => {
  it('scans real clients (admin and orders read accounts + api)', () => {
    expect(envBases('admin')).toEqual(
      expect.arrayContaining(['NEXT_PUBLIC_ACCOUNTS_URL', 'NEXT_PUBLIC_API_URL'])
    );
    expect(envBases('orders')).toEqual(
      expect.arrayContaining(['NEXT_PUBLIC_ACCOUNTS_URL', 'NEXT_PUBLIC_API_URL'])
    );
  });

  it.each(Object.keys(APPS))(
    '%s: every browser base is decided and its origin is in connect-src',
    app => {
      const src = connectSrc(APPS[app]);
      const undecided = envBases(app).filter(v => !(v in ORIGIN_OF));
      expect(
        undecided,
        `add ${undecided.join(', ')} to ORIGIN_OF in this test (origin or null + why)`
      ).toEqual([]);
      for (const v of envBases(app)) {
        const origin = ORIGIN_OF[v];
        if (origin) expect(src, `${app}: ${v} -> ${origin}`).toContain(origin);
      }
    }
  );

  it('connect-src never uses a bare wildcard or scheme-only source for the identity origin', () => {
    for (const app of ['admin', 'orders']) {
      const src = connectSrc(APPS[app]);
      expect(src).toContain('https://accounts.ebda.app');
      expect(src).not.toContain('*');
      expect(src).not.toContain('https:');
    }
  });
});
