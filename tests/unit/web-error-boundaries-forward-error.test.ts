import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isStoreTemporarilyUnavailable,
  STORE_UNAVAILABLE_DIGEST,
} from '@web/lib/store-unavailable';

/**
 * An enumeration gate over storefront error boundaries.
 *
 * The transient-store-resolve fix (docs/plans/2026-09-16-store-resolve-transient
 * -not-404.md) shows a "we're a little busy, try again" page instead of a 404
 * when the API is rate limiting us. Which body renders is decided from
 * `error.digest`, so a boundary that DISCARDS its error silently downgrades
 * that page back to a generic "something went wrong" — with no type error, no
 * lint error, and every resolver test still green.
 *
 * That is not hypothetical: the first draft of the fix put the branch only in
 * `app/error.tsx`, and `products/`, `products/[slug]/` and `bundles/[slug]/`
 * each have their own boundary that catches FIRST — so the entire user-visible
 * half of the fix was missing on the three highest-traffic storefront routes.
 * Found in review, not by any test, which is why this gate exists.
 *
 * It asserts on SOURCE TEXT: it proves each boundary FORWARDS the error, not
 * that the page renders (this repo has no DOM harness — see
 * BundlesPageBody.test.tsx). The rendering decision itself is covered by the
 * pure-predicate tests below.
 *
 * THE PRIMARY GATE IS `tsc`, not this file: `RouteErrorFallbackProps.error` is
 * REQUIRED, so a boundary that drops the error cannot compile. These source
 * assertions are deliberate defence in depth, and they are defeatable on their
 * own — the `_error` regex only catches that exact name, and the forwarding
 * check would be satisfied by a JSDoc block quoting `error={error}`. Neither
 * weakness matters while the prop is required; if anyone makes it optional
 * again, these become the only gate and both holes reopen.
 */

const APP_DIR = join(process.cwd(), 'apps/web/src/app');

/**
 * Every `error.tsx` under the storefront app tree.
 *
 * `global-error.tsx` is deliberately excluded: it replaces the whole document
 * when the ROOT LAYOUT itself failed, so no provider is mounted and it cannot
 * use the hook-based shared body.
 */
function errorBoundaries(): Array<{ rel: string; source: string }> {
  return readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' })
    .filter(p => {
      const name = p.split('/').pop() ?? '';
      return name === 'error.tsx';
    })
    .map(rel => ({ rel, source: readFileSync(join(APP_DIR, rel), 'utf8') }));
}

describe('every storefront error boundary forwards its error', () => {
  it('finds the boundaries at all (a gate over an empty set proves nothing)', () => {
    const found = errorBoundaries();
    // Positive control: if the glob silently stops matching, this fails loudly
    // rather than passing vacuously.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.map(f => f.rel)).toContain('error.tsx');
    expect(found.map(f => f.rel)).toContain('products/error.tsx');
  });

  it('never discards the error as `_error`', () => {
    const offenders = errorBoundaries()
      .filter(({ source }) => /error\s*:\s*_error/.test(source))
      .map(({ rel }) => rel);

    expect(
      offenders,
      `these boundaries throw the error away, so a rate-limited store renders ` +
        `"something went wrong" instead of the retry page: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('renders the SHARED body, so a new boundary cannot hand-roll its own copy', () => {
    // The hole this closes: `tsc` only gates boundaries that REFERENCE
    // RouteErrorFallback, and the assertion below only inspects those too. A
    // new segment boundary with its own inline JSX passes both while silently
    // dropping the retry copy on that route. 8 of the 11 store-resolving pages
    // still have no boundary (Ruling SR-5), so the next person to add one is
    // exactly the scenario at risk.
    const allowlist: string[] = [
      // (empty) — add a path here ONLY with a comment arguing why this
      // boundary must not use the shared body.
    ];
    const offenders = errorBoundaries()
      .filter(({ rel }) => !allowlist.includes(rel))
      .filter(({ source }) => !source.includes('<RouteErrorFallback'))
      .map(({ rel }) => rel);

    expect(
      offenders,
      `these boundaries hand-roll their own body, so the store-unavailable retry ` +
        `copy will not appear on their route: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('passes the error into RouteErrorFallback wherever it renders one', () => {
    const offenders = errorBoundaries()
      .filter(({ source }) => source.includes('<RouteErrorFallback'))
      .filter(({ source }) => !/<RouteErrorFallback[^>]*\berror=\{error\}/s.test(source))
      .map(({ rel }) => rel);

    expect(
      offenders,
      `these boundaries render the shared body without handing it the error: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});

describe('the retry page never links a merchant shopper to the platform', () => {
  /**
   * During a transient `getStore()` returns the demo-sentinel fallback, so
   * `useStoreUrl` drops the `/<slug>` prefix and "Go Home" resolves to `/`.
   * On the platform host that is not the merchant's storefront — measured
   * 2026-09-16, `https://ebda.app/` answers `307 → ebda.app`. So
   * the link must not render on that branch at all (Ruling SR-7); the HARD
   * multi-tenant rule is stated in `app/not-found.tsx`.
   */
  it('pairs the retry button with a router refresh, so it can actually recover', () => {
    // Next passes the BARE `reset` (error-boundary.js: `reset` only calls
    // setState; its own `retry` wraps `context.refresh()` + reset in a
    // transition). Bare reset re-renders the SAME failed server payload — and
    // on the transient branch this button is the only control, so without the
    // refresh the retry page is a dead end during the very outage it serves.
    const src = readFileSync(join(APP_DIR, '..', 'components', 'RouteErrorFallback.tsx'), 'utf8');

    expect(src).toContain('router.refresh()');
    expect(src).toContain('startTransition');
    expect(
      /onClick=\{retry\}/.test(src),
      'the retry button is wired to bare reset() again — it will not re-run the failed server render'
    ).toBe(true);
  });

  it('suppresses the Go Home link on the store-unavailable branch, but only on a platform host', () => {
    // Issue #1841 / CORRECTION to SR-7: the original guard suppressed the link
    // on EVERY host during a transient, including custom domains where `/` is
    // already the merchant's own storefront home and there is no platform
    // pitch to redirect a shopper to. The guard must reference BOTH
    // `isTemporarilyUnavailable` and `isPlatform` so it only hides the link
    // when both are true.
    const src = readFileSync(join(APP_DIR, '..', 'components', 'RouteErrorFallback.tsx'), 'utf8');

    expect(src).toContain('<Link');
    expect(
      /\{\(!isTemporarilyUnavailable \|\| !isPlatform\) && \(/.test(src),
      'the Go Home link must render whenever the request is not on a platform ' +
        'host OR the store is not merely temporarily unavailable — reverting to ' +
        'a bare `!isTemporarilyUnavailable` guard suppresses it for custom-domain ' +
        'merchants too, where the underlying platform-pitch defect does not exist'
    ).toBe(true);
    expect(
      src.includes('useIsPlatform'),
      'the platform-vs-custom-domain check must come from the shared useIsPlatform() ' +
        'hook (StoreContext.tsx), not a re-derived local check'
    ).toBe(true);
  });
});

describe('the retry page is not TITLED "Page not found"', () => {
  /**
   * `layout.tsx::generateMetadata` has two fallback branches that both fire on
   * the DEFAULT_STORE shape. The transient one must be checked FIRST: the demo
   * sentinel (`id === 'demo'`) also matches the transient fallback, so if the
   * order is ever swapped, a rate-limited storefront goes back to being titled
   * "Page not found — Ebda" around a body that says "we're a little busy".
   *
   * Asserted on source order because this repo has no way to render a Next
   * `generateMetadata` in a test. It proves the BRANCH ORDER, not the output.
   */
  const layout = readFileSync(join(APP_DIR, 'layout.tsx'), 'utf8');

  it('checks the transient flag before the demo sentinel', () => {
    const transientAt = layout.indexOf('store.transientResolveFailure');
    const demoAt = layout.indexOf("store.id === 'demo'");

    expect(transientAt, 'layout.tsx no longer reads transientResolveFailure').toBeGreaterThan(-1);
    expect(demoAt, 'the demo sentinel branch has moved or been renamed').toBeGreaterThan(-1);
    expect(
      transientAt,
      'the demo sentinel now matches first, so the retry page is titled "Page not found" again'
    ).toBeLessThan(demoAt);
  });
});

describe('the retry body is selected by digest, not by message', () => {
  it('recognises the store-unavailable digest', () => {
    expect(isStoreTemporarilyUnavailable({ digest: STORE_UNAVAILABLE_DIGEST })).toBe(true);
  });

  it('leaves an ordinary render error on the generic body', () => {
    expect(isStoreTemporarilyUnavailable(new Error('boom'))).toBe(false);
    expect(isStoreTemporarilyUnavailable({ digest: '1234567890' })).toBe(false);
  });

  it('is safe when the boundary was handed nothing', () => {
    expect(isStoreTemporarilyUnavailable(undefined)).toBe(false);
    expect(isStoreTemporarilyUnavailable(null)).toBe(false);
  });
});
