/**
 * Per-store activation timeline (Ruling ACT-1), folded from the CI stream by the daily aggregation and read by the
 * super-admin activation view. Pure: no R2, no clock. Ids and epoch milliseconds only (no buyer key, no person).
 *
 * Idempotent: every field is a min/max/latest over event times, so folding the same events twice (a replay, a
 * two-day overlap between runs) rewrites identical bytes.
 */
import { ONBOARDING_HELP_KINDS, ONBOARDING_STEPS, type CiEnvelope } from '../envelope';

type Step = (typeof ONBOARDING_STEPS)[number];
type HelpKind = (typeof ONBOARDING_HELP_KINDS)[number];

/** The last thing that happened to an order, in the words the view shows (a closed set: never a free-text reason). */
export const ORDER_FACTS = [
  'placed',
  'payment_failed',
  'paid',
  'cod_confirmed',
  'cod_unconfirmed',
  'cancelled',
  'refunded',
  'booked',
  'picked_up',
  'attempted',
  'delivered',
  'returned',
] as const;
export type OrderFact = (typeof ORDER_FACTS)[number];

const FACT_OF: Partial<Record<CiEnvelope['type'], OrderFact>> = {
  'order.placed': 'placed',
  'payment.failed': 'payment_failed',
  'payment.captured': 'paid',
  'order.cod_confirmed': 'cod_confirmed',
  'order.cod_unconfirmed': 'cod_unconfirmed',
  'order.cancelled': 'cancelled',
  'order.refunded': 'refunded',
  'shipment.created': 'booked',
  'shipment.picked_up': 'picked_up',
  'shipment.attempted': 'attempted',
  'shipment.delivered': 'delivered',
  'shipment.returned': 'returned',
};

/** Orders whose trail is kept per store. The first order is among a store's earliest, so a small cap holds it. */
export const TRAIL_CAP = 10;

export interface ActivationFile {
  v: 1;
  storeId: string;
  /** Owner signup (epoch ms), derived from any step's `secondsSinceSignup`; null if no step carried it. */
  signupAt: number | null;
  steps: Partial<Record<Step, { at: number; secondsSinceSignup: number | null }>>;
  firstOrder: { orderId: string | null; channel: string | null } | null;
  /** First time help was needed, per step and kind. */
  help: Partial<Record<Step, Partial<Record<HelpKind, number>>>>;
  trail: Record<string, { fact: OrderFact; at: number }>;
}

export const emptyActivation = (storeId: string): ActivationFile => ({
  v: 1,
  storeId,
  signupAt: null,
  steps: {},
  firstOrder: null,
  help: {},
  trail: {},
});

export function foldActivation(
  prev: ActivationFile | null,
  storeId: string,
  events: CiEnvelope[]
): ActivationFile {
  const f: ActivationFile = prev
    ? (JSON.parse(JSON.stringify(prev)) as ActivationFile)
    : emptyActivation(storeId);
  const ordered = events
    .filter(e => e.storeId === storeId)
    .sort((a, b) => a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : 1));
  for (const e of ordered) {
    if (e.type === 'merchant.onboarding_step') {
      const cur = f.steps[e.data.step];
      if (!cur || e.occurredAt < cur.at) {
        f.steps[e.data.step] = { at: e.occurredAt, secondsSinceSignup: e.data.secondsSinceSignup };
        if (e.data.step === 'first_order') {
          f.firstOrder = { orderId: e.data.orderId ?? null, channel: e.data.channel ?? null };
        }
      }
      if (e.data.secondsSinceSignup != null) {
        const signup = e.occurredAt - e.data.secondsSinceSignup * 1000;
        f.signupAt = f.signupAt == null ? signup : Math.min(f.signupAt, signup);
      }
    } else if (e.type === 'merchant.onboarding_help') {
      const byKind = (f.help[e.data.step] ??= {});
      const cur = byKind[e.data.kind];
      if (cur == null || e.occurredAt < cur) byKind[e.data.kind] = e.occurredAt;
    } else {
      const fact = FACT_OF[e.type];
      if (!fact || !e.orderId) continue;
      const cur = f.trail[e.orderId];
      if (!cur && Object.keys(f.trail).length >= TRAIL_CAP && e.orderId !== f.firstOrder?.orderId)
        continue;
      if (!cur || e.occurredAt >= cur.at) f.trail[e.orderId] = { fact, at: e.occurredAt };
    }
  }
  // stable key order so a replay writes identical bytes
  f.steps = Object.fromEntries(ONBOARDING_STEPS.filter(s => f.steps[s]).map(s => [s, f.steps[s]!]));
  f.help = Object.fromEntries(
    ONBOARDING_STEPS.filter(s => f.help[s]).map(s => [
      s,
      Object.fromEntries(
        ONBOARDING_HELP_KINDS.filter(k => f.help[s]![k] != null).map(k => [k, f.help[s]![k]!])
      ),
    ])
  );
  f.trail = Object.fromEntries(Object.entries(f.trail).sort(([a], [b]) => (a < b ? -1 : 1)));
  return f;
}

// ---------------------------------------------------------------- the view (read side)

export interface StepView {
  step: Step;
  reached: boolean;
  /** Seconds from the owner's signup to this step, or null if not reached / signup unknown. */
  secondsFromSignup: number | null;
  at: number | null;
  helpNeeded: boolean;
  helpKinds: HelpKind[];
}
export interface StoreActivationView {
  storeId: string;
  signupAt: number | null;
  steps: StepView[];
  firstOrderChannel: string | null;
  /** For an order that stopped before delivery: the last fact reached. Null when delivered or nothing ordered. */
  lastFact: { fact: OrderFact; at: number } | null;
}

export function viewOf(f: ActivationFile | null, storeId: string): StoreActivationView {
  const file = f ?? emptyActivation(storeId);
  const steps: StepView[] = ONBOARDING_STEPS.map(step => {
    const s = file.steps[step];
    const kinds = ONBOARDING_HELP_KINDS.filter(k => file.help[step]?.[k] != null);
    return {
      step,
      reached: !!s,
      at: s?.at ?? null,
      secondsFromSignup:
        s && file.signupAt != null
          ? Math.max(0, Math.round((s.at - file.signupAt) / 1000))
          : (s?.secondsSinceSignup ?? null),
      helpNeeded: kinds.length > 0,
      helpKinds: kinds,
    };
  });
  let lastFact: StoreActivationView['lastFact'] = null;
  if (!file.steps.first_fulfilled_order) {
    const own = file.firstOrder?.orderId ? file.trail[file.firstOrder.orderId] : undefined;
    const latest = Object.values(file.trail).sort((a, b) => b.at - a.at)[0];
    lastFact = own ?? latest ?? null;
  }
  return {
    storeId,
    signupAt: file.signupAt,
    steps,
    firstOrderChannel: file.firstOrder?.channel ?? null,
    lastFact,
  };
}

// ---------------------------------------------------------------- the funnel

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : Math.round((v[m - 1]! + v[m]!) / 2);
}

export interface FunnelRow {
  step: Step;
  count: number;
  medianSecondsFromSignup: number | null;
  helpStores: number;
}

/** Count + median time per step over the views whose signup falls in [fromMs, toMs]. A store with unknown signup is left out. */
export function funnelOf(views: StoreActivationView[], fromMs: number, toMs: number): FunnelRow[] {
  const inRange = views.filter(
    v => v.signupAt != null && v.signupAt >= fromMs && v.signupAt <= toMs
  );
  return ONBOARDING_STEPS.map(step => {
    const rows = inRange.map(v => v.steps.find(s => s.step === step)!);
    const secs = rows
      .filter(r => r.reached && r.secondsFromSignup != null)
      .map(r => r.secondsFromSignup!);
    return {
      step,
      count: rows.filter(r => r.reached).length,
      medianSecondsFromSignup: median(secs),
      helpStores: rows.filter(r => r.helpNeeded).length,
    };
  });
}
