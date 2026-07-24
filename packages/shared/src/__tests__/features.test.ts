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
