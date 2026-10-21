/**
 * Email campaigns are a Growth + Business feature (2026-10-21; supersedes the D2
 * "in NO plan baseline" rule). Basic does not get them. `store.plan` is synced
 * to the plan's `featureTier` (plan.service), so the legacy baseline is the gate:
 * Growth = professional, Business = enterprise, Basic = starter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  FEATURE_REGISTRY,
  getVisibleFeatures,
  PLAN_BASELINE,
  DEFAULT_PLAN_SEEDS,
  lowestPlanForFeature,
  publicPlanLabelForFeature,
} from '@ebda/shared';
import { campaignDailyCap } from '@api/services/campaign.service';

const tierOf = (code: string) => DEFAULT_PLAN_SEEDS.find(p => p.code === code)!.featureTier;

describe('email_campaigns plan gating', () => {
  it.each(['growth', 'business'])('%s includes email_campaigns', code => {
    expect(PLAN_BASELINE[tierOf(code) as 'professional' | 'enterprise']).toContain(
      'email_campaigns'
    );
  });

  it.each(['free', 'basic'])('%s does not include email_campaigns', code => {
    expect(PLAN_BASELINE[tierOf(code) as 'free' | 'starter']).not.toContain('email_campaigns');
  });

  it('is visible so a super-admin can still override per store', () => {
    expect(FEATURE_REGISTRY.email_campaigns.hidden).toBeFalsy();
    expect(getVisibleFeatures().map(f => f.key)).toContain('email_campaigns');
  });

  it('the upsell names the PUBLIC plan (Growth), not the legacy tier label', () => {
    expect(lowestPlanForFeature('email_campaigns')).toBe('professional');
    expect(publicPlanLabelForFeature('email_campaigns')).toEqual({ en: 'Growth', ar: 'النمو' });
    expect(publicPlanLabelForFeature('coupons')).toBeNull();
  });
});

describe('campaign daily send cap per plan', () => {
  afterEach(() => {
    delete process.env.CAMPAIGN_DAILY_SEND_CAP;
  });

  it('Growth 1000, Business 5000, anything else 500, unknown plan keeps the 1000 default', () => {
    expect(campaignDailyCap('professional')).toBe(1000);
    expect(campaignDailyCap('enterprise')).toBe(5000);
    expect(campaignDailyCap('starter')).toBe(500);
    expect(campaignDailyCap('free')).toBe(500);
    expect(campaignDailyCap()).toBe(1000);
  });

  it('an explicit CAMPAIGN_DAILY_SEND_CAP overrides every plan', () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '7';
    expect(campaignDailyCap('enterprise')).toBe(7);
    expect(campaignDailyCap()).toBe(7);
  });
});
