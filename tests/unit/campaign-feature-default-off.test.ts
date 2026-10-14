/**
 * D2 hard rule: email campaigns ship OFF for every store. The feature is
 * visible in the super-admin features list (un-hidden) but in NO plan
 * baseline, so it resolves off until a super-admin StoreFeature override.
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY, getVisibleFeatures, PLAN_BASELINE, STORE_PLANS } from '@ebda/shared';

describe('email_campaigns feature default', () => {
  it.each(STORE_PLANS)('is not in the %s plan baseline', plan => {
    expect(PLAN_BASELINE[plan]).not.toContain('email_campaigns');
  });

  it('is visible so a super-admin can toggle it per store', () => {
    expect(FEATURE_REGISTRY.email_campaigns.hidden).toBeFalsy();
    expect(getVisibleFeatures().map(f => f.key)).toContain('email_campaigns');
  });
});
