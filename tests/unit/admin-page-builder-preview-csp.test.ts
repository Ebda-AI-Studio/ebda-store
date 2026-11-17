import { describe, it, expect } from 'vitest';
import { buildAdminCsp, BUILDER_PREVIEW_PATH, adminApiOrigin } from '../../apps/admin/src/lib/csp';

/**
 * The page-builder preview must be able to embed ANY merchant's storefront, and (SEC-4) the admin's
 * CSP is now built per request in middleware (it carries a nonce), so this tests the policy builder
 * the middleware calls instead of the retired next.config.js header sources.
 *
 * `frame-src` governs what the admin may embed; the storefront's own `frame-ancestors` governs who
 * may embed it. Both must permit the embed; only the storefront side is a real access control.
 *
 * This broke in production once: frame-src was a hand-written list of merchant domains containing
 * exactly one tenant, so every merchant onboarded after that lost their live preview.
 */
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const API = 'https://api.ebda.app';
const csp = (pathname: string) => buildAdminCsp({ nonce: NONCE, pathname, apiOrigin: API });
const frameSrc = (c: string) => (c.match(/frame-src[^;]*/) ?? [''])[0];

const PATHS = [
  '/stores/abc123/builder',
  '/stores/abc123/builder/',
  '/stores/abc123/builder/extra',
  '/stores/abc123/builder-x',
  '/stores/abc123/page-builder',
  '/stores/abc123/products',
  '/dashboard',
  '/login',
  '/',
];

describe('only the bare builder route may frame any https origin', () => {
  it('route matcher', () => {
    expect(PATHS.filter(p => BUILDER_PREVIEW_PATH.test(p))).toEqual(['/stores/abc123/builder']);
  });

  it('the preview route gets the bare https: scheme', () => {
    // Compare TOKENS, never a substring: `toContain('https:')` is satisfied by `https://ebda.app`.
    expect(frameSrc(csp('/stores/abc123/builder')).split(/\s+/)).toContain('https:');
  });

  it.each(PATHS.filter(p => !BUILDER_PREVIEW_PATH.test(p)))('%s stays on the strict list', p => {
    const fs_ = frameSrc(csp(p));
    expect(fs_).toContain('https://*.ebda.app');
    expect(fs_.split(/\s+/)).not.toContain('https:');
  });

  it('ships no merchant domain in any allowlist', () => {
    for (const p of PATHS) {
      expect(csp(p)).not.toContain('demo-merchant');
      expect(csp(p)).not.toContain('demo-store');
    }
  });

  it('the admin can never be framed, on any route', () => {
    for (const p of PATHS) expect(csp(p)).toContain("frame-ancestors 'none'");
  });
});

describe('SEC-4: nonce-based script-src', () => {
  const scriptSrc = (c: string) => (c.match(/(?:^|; )script-src [^;]*/) ?? [''])[0];

  it.each(PATHS)('%s: nonce + strict-dynamic, no unsafe-inline, no unsafe-eval, no ad hosts', p => {
    const s = scriptSrc(csp(p));
    expect(s).toContain(`'nonce-${NONCE}'`);
    expect(s).toContain("'strict-dynamic'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
    expect(csp(p)).not.toContain('facebook');
  });

  it('a different nonce yields a different policy and the old nonce does not survive', () => {
    const a = buildAdminCsp({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', pathname: '/', apiOrigin: API });
    const b = buildAdminCsp({ nonce: 'BBBBBBBBBBBBBBBBBBBBBB==', pathname: '/', apiOrigin: API });
    expect(a).not.toBe(b);
    expect(b).not.toContain('AAAAAAAAAAAAAAAAAAAAAA==');
  });

  it("keeps the data-exfil floor: object-src 'none', base-uri 'self', form-action 'self', script-src-attr 'none'", () => {
    const c = csp('/');
    for (const d of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "script-src-attr 'none'",
    ]) {
      expect(c).toContain(d);
    }
  });

  it('connects to the configured API over https and wss', () => {
    expect(csp('/')).toContain(`connect-src 'self' ${API} wss://api.ebda.app`);
  });
});

describe('adminApiOrigin', () => {
  it('defaults to production and refuses a non-https, non-loopback API', () => {
    expect(adminApiOrigin(undefined)).toBe('https://api.ebda.app');
    expect(adminApiOrigin('http://localhost:4000')).toBe('http://localhost:4000');
    expect(() => adminApiOrigin('http://evil.example')).toThrow(/HTTPS/);
  });
});

import { builderNeedsDocumentReload } from '../../apps/admin/src/lib/csp';

describe('builder reached by client-side navigation keeps the wrong frame-src (custom-domain preview blocked)', () => {
  const base = 'https://store.ebda.app/stores/abc/builder';
  it('document first loaded on another admin page -> must hard reload', () => {
    expect(builderNeedsDocumentReload('https://store.ebda.app/stores/abc', base)).toBe(true);
    expect(builderNeedsDocumentReload('https://store.ebda.app/dashboard', base)).toBe(true);
  });
  it('document that IS the builder (even with query) -> no reload, no loop', () => {
    expect(builderNeedsDocumentReload('https://store.ebda.app/stores/abc/builder', base)).toBe(
      false
    );
    expect(
      builderNeedsDocumentReload('https://store.ebda.app/stores/abc/builder?page=cart', base)
    ).toBe(false);
  });
  it('no navigation entry -> no reload', () => {
    expect(builderNeedsDocumentReload(undefined, base)).toBe(false);
  });
});
