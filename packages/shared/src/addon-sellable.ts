/**
 * Which features a merchant can buy on top of their plan (SELF-SERVICE add-ons, Ahmad 2026-11-15):
 *
 *   sellable(store) = (Business baseline) minus (the store's own plan baseline)
 *
 * COMPUTED from `PLAN_BASELINE`, never hand-listed, so moving a feature into or out of a plan changes what is sold with
 * no second edit. Business holds every feature, so a Business store is never offered one; only Basic and Growth stores
 * can buy a single feature. The two exceptions below are not plan features at all.
 */
import { FEATURE_REGISTRY, type FeatureKey } from './features';
import { PLAN_BASELINE } from './plan-baselines';
import type { StorePlan } from './types';

/** The plan that contains every feature. */
const TOP_PLAN: StorePlan = 'enterprise';
/** The plans whose owner may buy one feature (Free picks a plan; Business already has everything). */
const BUYER_PLANS: readonly StorePlan[] = ['starter', 'professional'];

/**
 * Never sold as a monthly feature: `whatsapp` and `sms` are messaging, which lives in the Ebda Chat product (its own plans,
 * own repo; Ahmad 2026-11-15); the agent-checkout open-writes switch is a security escape hatch only a super admin may flip;
 * `customer_intelligence` is switched on and off by the OWNER on any plan (Ruling CI-10, `PUT /ci/hints`), so selling it
 * would charge for something the merchant can turn on free (money review of #859). Ahmad's approved price (EGP 149) is
 * parked until he decides whether the owner toggle becomes plan/purchase-gated.
 */
// pq-allow(unused-export): test seam, imported by tests/unit/addon-sellable.test.ts
export const NEVER_SOLD_FEATURES: ReadonlySet<string> = new Set([
  'whatsapp',
  'sms',
  'agent_checkout_open_writes',
  'customer_intelligence',
]);

/** Every feature Business holds that is a real, visible, sellable product (the catalogue of possible add-ons). */
export function addonFeatureKeys(): FeatureKey[] {
  const top = new Set<string>(PLAN_BASELINE[TOP_PLAN]);
  return (Object.keys(FEATURE_REGISTRY) as FeatureKey[]).filter(
    k => top.has(k) && !NEVER_SOLD_FEATURES.has(k) && !FEATURE_REGISTRY[k].hidden
  );
}

/** The catalogue sku that sells this feature, or null when it is never sold as an add-on. */
export function addonSkuForFeature(key: string | null | undefined): string | null {
  return key && (addonFeatureKeys() as string[]).includes(key) ? `feature:${key}` : null;
}

/** May a store on `plan` buy `key`? Only Basic/Growth stores, and only what their own plan lacks. */
export function canBuyFeatureOnPlan(plan: string, key: string): boolean {
  if (!(BUYER_PLANS as readonly string[]).includes(plan)) return false;
  if (!(addonFeatureKeys() as string[]).includes(key)) return false;
  return !(PLAN_BASELINE[plan as StorePlan] as readonly string[]).includes(key);
}
