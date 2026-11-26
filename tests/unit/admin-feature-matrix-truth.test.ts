import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY } from '../../packages/shared/src/features';
import { featureTriState } from '../../apps/admin/src/lib/feature-state';

describe('STORE-QA-13 feature matrix reads the effective plan, not a stale tier', () => {
  it('no override: the server-resolved value decides (plan LIMIT features are not "not included")', () => {
    // wholesale / MCP write come from plan limits, in no tier baseline
    expect(
      featureTriState('enterprise', 'b2b.wholesale', undefined, { 'b2b.wholesale': true })
    ).toBe('baseline_on');
    expect(
      featureTriState('enterprise', 'b2b.wholesale', undefined, { 'b2b.wholesale': false })
    ).toBe('baseline_off');
  });
  it('legacy parent inventory is on whenever a sub-feature is', () => {
    expect(featureTriState('enterprise', 'inventory', undefined, { 'inventory.basic': true })).toBe(
      'baseline_on'
    );
    expect(featureTriState('free', 'inventory', undefined, { 'inventory.basic': false })).toBe(
      'baseline_off'
    );
  });
  it('an override row keeps its tri-state against the effective tier', () => {
    expect(featureTriState('free', 'bundles', { featureKey: 'bundles', enabled: true }, {})).toBe(
      'override_on'
    );
    expect(
      featureTriState('enterprise', 'coupons', { featureKey: 'coupons', enabled: false }, {})
    ).toBe('override_off');
  });
});

describe('STORE-QA-14 feature copy carries no internals', () => {
  it('no provider, header, algorithm or timezone leaks in names or descriptions', () => {
    const bad = /Unifonic|X-Agent-Key|Haversine|KWT|super-admin override|المشرف العام/;
    for (const f of Object.values(FEATURE_REGISTRY)) {
      for (const text of [f.name, f.nameAr, f.description, f.descriptionAr]) {
        expect(text, f.key).not.toMatch(bad);
      }
    }
  });
});

import { getStoreHref, getStoreDisplayUrl, liveDomain } from '../../apps/admin/src/lib/store-url';

describe('STORE-QA-23 an unverified custom domain is never the live store URL', () => {
  it('pending/failed claims fall back to the ebda subdomain; active/legacy stay live', () => {
    const base = { slug: 'amelia-aurum', domain: 'ameliaaurum.com' };
    expect(liveDomain({ ...base, domainStatus: 'pending' })).toBeNull();
    expect(getStoreHref({ ...base, domainStatus: 'pending' })).toBe(
      'https://amelia-aurum.ebda.app'
    );
    expect(getStoreDisplayUrl({ ...base, domainStatus: 'failed' })).toBe('amelia-aurum.ebda.app');
    expect(getStoreHref({ ...base, domainStatus: 'active' })).toBe('https://ameliaaurum.com');
    expect(getStoreHref(base)).toBe('https://ameliaaurum.com');
  });
});
