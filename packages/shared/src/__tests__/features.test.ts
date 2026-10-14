import { describe, it, expect } from 'vitest';
import { FEATURE_KEYS_ARRAY, FEATURE_REGISTRY } from '../features';
import { PLAN_BASELINE } from '../plan-baselines';

describe('agent_checkout feature key', () => {
  it('is registered', () => {
    expect(FEATURE_KEYS_ARRAY).toContain('agent_checkout');
    expect(FEATURE_REGISTRY.agent_checkout.key).toBe('agent_checkout');
  });
  it('is baseline on every paid plan, off on free', () => {
    expect(PLAN_BASELINE.starter).toContain('agent_checkout');
    expect(PLAN_BASELINE.professional).toContain('agent_checkout');
    expect(PLAN_BASELINE.enterprise).toContain('agent_checkout');
    expect(PLAN_BASELINE.free).not.toContain('agent_checkout');
  });
});

describe('super-admin vs merchant feature lists (WHATSAPP-OFF-1)', () => {
  it('merchant list hides whatsapp; super-admin list includes only allowlisted hidden features', async () => {
    const { getVisibleFeatures, getSuperAdminFeatures } = await import('../features');
    const merchant = getVisibleFeatures().map(f => f.key);
    const admin = getSuperAdminFeatures().map(f => f.key);
    expect(merchant).not.toContain('whatsapp');
    expect(admin).toContain('whatsapp');
    expect(admin).not.toContain('seo');
    expect(admin).not.toContain('search_autocomplete');
  });
});
