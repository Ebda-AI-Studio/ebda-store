/**
 * Go-live verdict: a PURE decision on one store's subscription (Ruling EBDA-FUNNEL-5). Lives
 * in its own file so the account service (suspension/coverage) and the go-live gate can both
 * use it without an import cycle; `go-live-gate` re-exports it.
 */
import { isGrantedPlan } from './period';
import type { TrialCardMode } from './index';

export interface GateSub {
  status: string;
  planCode: string;
  trialEndsAt: Date | null;
  provider: string | null;
  providerPaymentMethodRef: string | null;
  billingMethod?: string | null;
}

export type GateVerdict =
  | { ok: true; reason: 'granted' | 'trial_with_card' | 'trial_instapay' | 'paid_active' }
  | {
      ok: false;
      code: 'PAYMENT_METHOD_REQUIRED' | 'TRIAL_EXPIRED' | 'NO_SUBSCRIPTION' | 'STORE_LIMIT_REACHED';
    };

/** Pure decision for ONE store's own subscription. */
export function goLiveVerdict(sub: GateSub | null, _mode: TrialCardMode, now: Date): GateVerdict {
  if (!sub) return { ok: false, code: 'NO_SUBSCRIPTION' };
  if (sub.status === 'comped' || isGrantedPlan(sub.planCode))
    return { ok: true, reason: 'granted' };
  const hasCard = !!sub.provider && !!sub.providerPaymentMethodRef;
  if (sub.status === 'trialing') {
    if (!sub.trialEndsAt || sub.trialEndsAt.getTime() <= now.getTime()) {
      return { ok: false, code: 'TRIAL_EXPIRED' };
    }
    if (hasCard) return { ok: true, reason: 'trial_with_card' };
    if (sub.billingMethod === 'instapay') return { ok: true, reason: 'trial_instapay' };
    return { ok: false, code: 'PAYMENT_METHOD_REQUIRED' };
  }
  if (sub.status === 'active' && (hasCard || sub.billingMethod === 'instapay')) {
    return { ok: true, reason: 'paid_active' };
  }
  return { ok: false, code: 'PAYMENT_METHOD_REQUIRED' };
}
