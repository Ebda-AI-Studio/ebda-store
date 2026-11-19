import { isInBaseline, type FeatureKey, type StorePlan } from '@ebda/shared';

export type TriState = 'baseline_on' | 'override_on' | 'override_off' | 'baseline_off';

interface OverrideRow {
  featureKey: string;
  enabled: boolean;
}

/**
 * The super-admin matrix state of one feature (STORE-QA-13).
 *  - `tier` is the feature-baseline tier of the store's EFFECTIVE plan (billing/entitlements), never the legacy `stores.plan`.
 *  - `effective` is what the server resolved for the store (plan baseline + plan limits like wholesale/MCP + overrides).
 *    With no override row the effective value IS the answer, so a feature a plan LIMIT grants (wholesale, MCP write) is not
 *    shown "not included". The legacy parent `inventory` is on whenever any `inventory.*` sub-feature is.
 */
export function featureTriState(
  tier: StorePlan,
  key: FeatureKey,
  override: OverrideRow | undefined,
  effective: Record<string, boolean> | undefined
): TriState {
  const inBaseline = isInBaseline(tier, key);
  if (override) {
    if (override.enabled) return inBaseline ? 'baseline_on' : 'override_on';
    return inBaseline ? 'override_off' : 'baseline_off';
  }
  if (!effective) return inBaseline ? 'baseline_on' : 'baseline_off';
  const on =
    key === 'inventory'
      ? effective.inventory === true ||
        Object.entries(effective).some(([k, v]) => k.startsWith('inventory.') && v === true)
      : effective[key] === true;
  return on ? 'baseline_on' : 'baseline_off';
}
