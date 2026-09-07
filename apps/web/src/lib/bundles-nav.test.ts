import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBundlesNavEntry, bundlesNavVisible } from './bundles-nav';

const BASE_NAV = [
  { label: 'Products', href: '/products' },
  { label: 'Categories', href: '/categories' },
];

describe('withBundlesNavEntry', () => {
  it('does NOT add a Bundles entry when bundlesNavVisible is false — feature-off or zero-purchasable-bundle stores show no dead link', () => {
    const result = withBundlesNavEntry(BASE_NAV, false, '/bundles');
    expect(result).toEqual(BASE_NAV);
    expect(result.some(n => n.href === '/bundles')).toBe(false);
  });

  it('appends a Bundles entry, bilingual, when bundlesNavVisible is true and nothing already links there', () => {
    const result = withBundlesNavEntry(BASE_NAV, true, '/bundles');
    expect(result).toHaveLength(BASE_NAV.length + 1);
    const bundlesEntry = result.find(n => n.href === '/bundles');
    expect(bundlesEntry).toBeDefined();
    expect(bundlesEntry!.label).toBe('Bundles');
    expect(bundlesEntry!.labelAr).toBe('الباقات');
  });

  it('does not duplicate the entry when the merchant already placed an explicit /bundles link', () => {
    const navWithExplicit = [...BASE_NAV, { label: 'Our Kits', href: '/bundles' }];
    const result = withBundlesNavEntry(navWithExplicit, true, '/bundles');
    expect(result).toEqual(navWithExplicit);
    expect(result.filter(n => n.href.endsWith('/bundles'))).toHaveLength(1);
  });

  it('respects a store-prefixed platform href (storeUrl output) as an explicit placement too', () => {
    const navWithExplicit = [...BASE_NAV, { label: 'Kits', href: '/my-store/bundles' }];
    const result = withBundlesNavEntry(navWithExplicit, true, '/my-store/bundles');
    expect(result).toEqual(navWithExplicit);
  });

  it('never mutates the input array', () => {
    const original = [...BASE_NAV];
    withBundlesNavEntry(BASE_NAV, true, '/bundles');
    expect(BASE_NAV).toEqual(original);
  });
});

// P2-c (scoped re-review): `bundlesNavVisible` used to be an inline
// expression in ShopChrome.tsx, asserted only by a `toContain` grep on the
// exact string — a rename or reformat reddens that test without any
// behaviour changing, and a real logic bug that keeps the substring intact
// (e.g. swapping `=== true` for `!== false`, which differs on `undefined`)
// could slip through. It is now a real, unit-tested function.
describe('bundlesNavVisible', () => {
  it('is true only when the enabledFeatures array actually contains "bundles"', () => {
    expect(bundlesNavVisible(['bundles'])).toBe(true);
    expect(bundlesNavVisible(['bundles', 'loyalty'])).toBe(true);
  });

  it('is false for a missing, empty, or non-matching enabledFeatures value', () => {
    expect(bundlesNavVisible(undefined)).toBe(false);
    expect(bundlesNavVisible(null)).toBe(false);
    expect(bundlesNavVisible([])).toBe(false);
    expect(bundlesNavVisible(['loyalty'])).toBe(false);
  });
});

/**
 * P1-6 (final review): `ShopChrome` wraps EVERY storefront page, and it used
 * to call a `useBundlesNavVisible` hook that issued
 * `GET /stores/public/:storeId/bundles` on mount — per store, per page view,
 * with no memo and no cache — just to decide whether to show a nav entry.
 * `bundles` is in no plan baseline, so essentially every merchant on the
 * platform paid a round-trip per page view to be told `403 FEATURE_DISABLED`,
 * spending both the per-IP and per-tenant public rate-limit budgets on a
 * value that is false.
 *
 * The visibility now comes off the store-resolve payload `StoreContext`
 * already fetches, the same shape `store.locationsEnabled` uses. There is no
 * DOM harness in this repo (see `bundles-nav.ts`'s doc comment), so the
 * "issues no request" half is asserted against the component source the way
 * `tests/unit/bundle-schema.test.ts` asserts against the migration DDL.
 */
describe('ShopChrome issues no bundles request', () => {
  const shopChromeRaw = readFileSync(join(__dirname, '../components/ShopChrome.tsx'), 'utf8');
  // Comments explain the removed hook by name, so assert against CODE only —
  // same technique as bundle-schema.test.ts stripping the migration's own
  // header comment before asserting on the DDL.
  const shopChrome = shopChromeRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('does not fetch the public bundles list', () => {
    expect(shopChrome).not.toContain('getPublicBundles');
    expect(shopChrome).not.toContain('useBundlesNavVisible');
    expect(shopChrome).not.toContain('api.get');
  });

  it('the per-page-render hook is gone from the tree entirely', () => {
    expect(existsSync(join(__dirname, '../hooks/useBundlesNavVisible.ts'))).toBe(false);
  });

  // P2-c: asserts ONLY that ShopChrome wires the store payload through the
  // real, behaviourally-tested `bundlesNavVisible` (above) — not the exact
  // boolean expression, which would redden on a harmless rename/reformat
  // and would not have caught a logic bug that keeps the substring intact.
  it('reads the nav decision off the store payload via bundlesNavVisible, like locationsEnabled does', () => {
    expect(shopChrome).toContain('bundlesNavVisible(store.enabledFeatures)');
  });

  it('the nav entry still appears when the store payload says bundles are enabled', () => {
    expect(withBundlesNavEntry(BASE_NAV, bundlesNavVisible(['bundles']), '/bundles')).toHaveLength(
      BASE_NAV.length + 1
    );
    // …and stays absent for the ~100% of stores without the feature, with no
    // request needed to find that out.
    expect(withBundlesNavEntry(BASE_NAV, bundlesNavVisible(['loyalty']), '/bundles')).toEqual(
      BASE_NAV
    );
    expect(withBundlesNavEntry(BASE_NAV, bundlesNavVisible(undefined), '/bundles')).toEqual(
      BASE_NAV
    );
  });
});
