import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';

/**
 * The page-builder preview must be able to embed ANY merchant's storefront.
 *
 * `frame-src` governs what the admin may embed; the storefront's own
 * `frame-ancestors` governs who may embed it. Both must permit the embed, and
 * only the storefront side is a real access control — it names the admin
 * origins explicitly and is untouched by anything here.
 *
 * This broke in production: the admin's frame-src was a hand-written list of
 * merchant domains containing exactly one tenant (`wadyaljuz.com`). Every
 * merchant onboarded after that silently lost their live preview and got
 * Chrome's "This content is blocked" — Pecannbee among them, because
 * `pecannbee.com.kw` was never added. A custom domain is arbitrary and
 * unknowable at build time, so an allowlist is wrong by construction.
 */

const CONFIG = fs.readFileSync(path.resolve(process.cwd(), 'apps/admin/next.config.js'), 'utf-8');

/** Pull a `const NAME = 'value';` string literal out of the raw config text. */
function readStringConst(name: string): string {
  const m = new RegExp(`const ${name} = '([^']*)';`).exec(CONFIG);
  if (!m) throw new Error(`${name} not found in apps/admin/next.config.js as a plain string const`);
  return m[1];
}

// The config's OWN route patterns — not hand-typed copies. If next.config.js
// stops exporting these under these names, this throws rather than silently
// comparing against a stale guess.
const PAGE_BUILDER_PREVIEW_SOURCE = readStringConst('PAGE_BUILDER_PREVIEW_SOURCE');
const ADMIN_CATCHALL_SOURCE = readStringConst('ADMIN_CATCHALL_SOURCE');

/** Representative admin paths, including the exact edge cases that matter. */
const ADMIN_PATHS = [
  '/stores/abc123/page-builder',
  '/stores/store-with-dashes/page-builder',
  '/stores/abc123/page-builder/',
  '/stores/abc123/page-builder/extra',
  '/stores/abc123/products',
  '/stores/abc123/dashboard',
  '/dashboard',
  '/login',
  '/',
];

// `/stores/:id/page-builder/` (trailing slash) matches BOTH patterns — a
// pre-existing characteristic of the exact regex shipped today, unchanged by
// the #1677 named-capture-group rewrite (verified identical on both forms
// before switching). Not a security regression: both rules' header sets are
// equally or more restrictive, and no batch issue asked for a routing
// behaviour change, so this test documents the overlap rather than "fixing"
// it as an unrelated, unreviewed change.
const TRAILING_SLASH_OVERLAP = '/stores/abc123/page-builder/';

describe('admin headers() route patterns match the real paths they claim to', () => {
  it('the preview-route pattern matches page-builder paths (incl. the trailing-slash overlap)', () => {
    const re = pathToRegexp(PAGE_BUILDER_PREVIEW_SOURCE);
    const matched = ADMIN_PATHS.filter(p => re.test(p));
    expect(matched.sort()).toEqual(
      [
        '/stores/abc123/page-builder',
        '/stores/store-with-dashes/page-builder',
        TRAILING_SLASH_OVERLAP,
      ].sort()
    );
  });

  it('the catch-all pattern matches everything except a bare page-builder path', () => {
    const re = pathToRegexp(ADMIN_CATCHALL_SOURCE);
    const matched = ADMIN_PATHS.filter(p => re.test(p));
    expect(matched.sort()).toEqual(
      [
        '/stores/abc123/page-builder/extra',
        '/stores/abc123/products',
        '/stores/abc123/dashboard',
        '/dashboard',
        '/login',
        '/',
        TRAILING_SLASH_OVERLAP,
      ].sort()
    );
  });

  it('the two patterns partition ADMIN_PATHS, except the documented trailing-slash overlap', () => {
    const previewRe = pathToRegexp(PAGE_BUILDER_PREVIEW_SOURCE);
    const catchallRe = pathToRegexp(ADMIN_CATCHALL_SOURCE);
    for (const p of ADMIN_PATHS) {
      const inPreview = previewRe.test(p);
      const inCatchall = catchallRe.test(p);
      if (p === TRAILING_SLASH_OVERLAP) {
        expect(inPreview && inCatchall, `${p} is expected to match both`).toBe(true);
        continue;
      }
      expect(
        inPreview !== inCatchall,
        `${p}: preview=${inPreview} catchall=${inCatchall} — must be exactly one`
      ).toBe(true);
    }
  });
});

/** The generated header sets, evaluated without Next's plugin wrapper. */
async function rules(): Promise<{ source: string; csp: string; headerKeys: string[] }[]> {
  const start = CONFIG.indexOf('const DEFAULT_FRAME_SRC');
  const end = CONFIG.search(/^(const nextConfig|module\.exports)/m);
  const body = CONFIG.slice(start, end);
  const make = new Function(
    `${body}
     return [
       { source: PAGE_BUILDER_PREVIEW_SOURCE, csp: securityHeaders(PREVIEW_PAGE_FRAME_SRC) },
       { source: ADMIN_CATCHALL_SOURCE, csp: securityHeaders(DEFAULT_FRAME_SRC) },
     ];`
  ) as () => { source: string; csp: { key: string; value: string }[] }[];
  return make().map(r => ({
    source: r.source,
    csp: r.csp.find(h => h.key === 'Content-Security-Policy')!.value,
    headerKeys: r.csp.map(h => h.key),
  }));
}

const frameSrc = (csp: string) => (csp.match(/frame-src[^;]*/) ?? [''])[0];

describe('page-builder preview CSP', () => {
  it('lets the preview route embed an arbitrary merchant domain', async () => {
    const preview = (await rules()).find(r => r.source === PAGE_BUILDER_PREVIEW_SOURCE)!;
    // Compare TOKENS, never a substring: `toContain('https:')` is satisfied by
    // `https://store.force-ai.co`, so the strict list — the original bug —
    // passed this assertion. Mutation testing caught it.
    expect(frameSrc(preview.csp).split(/\s+/)).toContain('https:');
  });

  it('keeps every other admin route on the strict list', async () => {
    const other = (await rules()).find(r => r.source === ADMIN_CATCHALL_SOURCE)!;
    const fs_ = frameSrc(other.csp);
    expect(fs_).toContain('https://*.force-ai.co');
    // The bare scheme must NOT leak into the catch-all.
    expect(fs_.split(/\s+/)).not.toContain('https:');
  });

  it('still refuses to let the admin itself be framed', async () => {
    for (const r of await rules()) {
      expect(r.csp).toContain("frame-ancestors 'none'");
    }
  });

  it('ships no merchant domain in the allowlist — that is what broke it', async () => {
    // Asserted against the EMITTED header, not the file: the comment above the
    // constant names `wadyaljuz.com` on purpose, to record why a hand-kept
    // list was the wrong shape. Forbidding the string anywhere would delete
    // the explanation along with the bug.
    for (const r of await rules()) {
      expect(frameSrc(r.csp)).not.toContain('wadyaljuz');
      expect(frameSrc(r.csp)).not.toContain('pecannbee');
    }
  });

  it('applies the same, explicit header set to both routes', async () => {
    // An explicit expected key array, not a self-comparison of the two rules'
    // key lists — that self-comparison is true BY CONSTRUCTION for any
    // implementation, since frameSrc only ever changes the CSP header's
    // VALUE, never the key list, so it could never go red on a deleted
    // header (#1694). Every route also gets a real page-builder-vs-catch-all
    // source via the match-matrix tests above.
    const EXPECTED_KEYS = [
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
      'Content-Security-Policy',
      'X-Robots-Tag',
    ];
    for (const r of await rules()) {
      expect(r.headerKeys).toEqual(EXPECTED_KEYS);
    }
  });

  it('headers() itself wires the named consts, not a desynced literal (#1695)', async () => {
    // Every prior assertion in this file drives PAGE_BUILDER_PREVIEW_SOURCE /
    // ADMIN_CATCHALL_SOURCE directly — none of them prove that the `headers()`
    // function actually returns entries built FROM those same consts, as
    // opposed to a copy-pasted literal that silently drifted from them. Assert
    // against the real `source: <ident>` wiring in the function body text.
    const start = CONFIG.indexOf('async headers()');
    const end = CONFIG.indexOf('};', start);
    const body = CONFIG.slice(start, end);
    const sources = [...body.matchAll(/source:\s*([A-Za-z_][\w]*),/g)].map(m => m[1]);
    expect(sources, 'headers() source wiring moved — re-point this test').toEqual(
      expect.arrayContaining(['PAGE_BUILDER_PREVIEW_SOURCE', 'ADMIN_CATCHALL_SOURCE'])
    );
  });

  it('the real headers() source patterns route each URL to the right CSP (#1695)', async () => {
    // Compile the REAL exported consts (proven wired into headers() by the
    // test above) with the same path-matching library Next.js uses, and
    // assert the match matrix against representative URLs — a typo or missing
    // `$` anchor in either const would still ship green without this.
    const pageBuilderRe = pathToRegexp(PAGE_BUILDER_PREVIEW_SOURCE);
    const catchAllRe = pathToRegexp(ADMIN_CATCHALL_SOURCE);

    const cases: Array<{ url: string; matchesPageBuilder: boolean }> = [
      { url: '/stores/abc123/page-builder', matchesPageBuilder: true },
      { url: '/stores/abc123/orders', matchesPageBuilder: false },
      { url: '/dashboard', matchesPageBuilder: false },
      { url: '/', matchesPageBuilder: false },
      // A trailing segment past page-builder is NOT the preview route.
      { url: '/stores/abc123/page-builder/extra', matchesPageBuilder: false },
    ];

    for (const { url, matchesPageBuilder } of cases) {
      const hitsPageBuilder = pageBuilderRe.test(url);
      const hitsCatchAll = catchAllRe.test(url);
      expect(
        hitsPageBuilder,
        `${url} should${matchesPageBuilder ? '' : ' not'} match the page-builder source`
      ).toBe(matchesPageBuilder);
      // Exactly one CSP must apply to any given path — that ordering
      // guarantee is the whole reason the catch-all excludes page-builder.
      expect(hitsCatchAll, `${url} must match exactly one of the two header sources`).toBe(
        !matchesPageBuilder
      );
    }
  });
});
