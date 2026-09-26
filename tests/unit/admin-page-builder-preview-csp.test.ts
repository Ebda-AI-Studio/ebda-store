import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToRegexp } from 'path-to-regexp';

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

/** The generated header sets, evaluated without Next's plugin wrapper. */
async function rules(): Promise<{ source: string; csp: string }[]> {
  const start = CONFIG.indexOf('const PREVIEW_FRAME_SRC');
  const end = CONFIG.search(/^(const nextConfig|module\.exports)/m);
  const body = CONFIG.slice(start, end);
  const make = new Function(
    `${body}
     return [
       { source: 'page-builder', csp: securityHeaders(PREVIEW_PAGE_FRAME_SRC) },
       { source: 'other', csp: securityHeaders(PREVIEW_FRAME_SRC) },
     ];`
  ) as () => { source: string; csp: { key: string; value: string }[] }[];
  return make().map(r => ({
    source: r.source,
    csp: r.csp.find(h => h.key === 'Content-Security-Policy')!.value,
  }));
}

const frameSrc = (csp: string) => (csp.match(/frame-src[^;]*/) ?? [''])[0];

describe('page-builder preview CSP', () => {
  it('lets the preview route embed an arbitrary merchant domain', async () => {
    const preview = (await rules()).find(r => r.source === 'page-builder')!;
    // Compare TOKENS, never a substring: `toContain('https:')` is satisfied by
    // `https://store.force-ai.co`, so the strict list — the original bug —
    // passed this assertion. Mutation testing caught it.
    expect(frameSrc(preview.csp).split(/\s+/)).toContain('https:');
  });

  it('keeps every other admin route on the strict list', async () => {
    const other = (await rules()).find(r => r.source === 'other')!;
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

  it('applies the same, complete header set to both routes', async () => {
    // Pinned to an explicit expected key list (#1694), not a self-comparison:
    // `securityHeaders('https:')` vs `securityHeaders(PREVIEW_FRAME_SRC)` are
    // the SAME function with only its one varying argument, so an equality
    // check between the two outputs is tautological by construction — it
    // would still pass if a header key were silently deleted from the
    // function entirely. Assert against the full expected set instead, so a
    // deletion (e.g. of a future X-Robots-Tag key) turns this red.
    const EXPECTED_KEYS = [
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
      'Content-Security-Policy',
    ];
    for (const r of await rules()) {
      const keys = (await headerKeys(r.source)).sort();
      expect(keys, `${r.source} header set drifted from the expected list`).toEqual(
        [...EXPECTED_KEYS].sort()
      );
    }
  });

  it('the real headers() source patterns route each URL to the right CSP (#1695)', async () => {
    // Every prior assertion in this file hand-invokes securityHeaders() with
    // test-invented labels ('page-builder' / 'other') — it never evaluates
    // the actual `source` regex patterns in next.config.js's headers()
    // function. A typo or missing `$` anchor there would still ship green.
    // Compile the REAL source strings with the same path-matching library
    // Next.js uses, and assert the match matrix against representative URLs.
    const start = CONFIG.indexOf('async headers()');
    const end = CONFIG.indexOf('};', start);
    const body = CONFIG.slice(start, end);
    const sources = [...body.matchAll(/source:\s*'([^']+)'/g)].map(m => m[1]);
    expect(sources, 'headers() source patterns moved — re-point this test').toHaveLength(2);
    const [pageBuilderSource, catchAllSource] = sources;

    const pageBuilderRe = pathToRegexp(pageBuilderSource);
    const catchAllRe = pathToRegexp(catchAllSource);

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

/** The header keys the real securityHeaders() emits for a given route's frameSrc. */
async function headerKeys(source: string): Promise<string[]> {
  const start = CONFIG.indexOf('const PREVIEW_FRAME_SRC');
  const end = CONFIG.search(/^(const nextConfig|module\.exports)/m);
  const frameSrcArg = source === 'page-builder' ? 'PREVIEW_PAGE_FRAME_SRC' : 'PREVIEW_FRAME_SRC';
  const make = new Function(
    `${CONFIG.slice(start, end)}
     return securityHeaders(${frameSrcArg});`
  ) as () => { key: string }[];
  return make().map(h => h.key);
}
