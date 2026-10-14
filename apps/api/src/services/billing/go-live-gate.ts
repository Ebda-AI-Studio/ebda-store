/**
 * Go-live gate (Ruling EBDA-FUNNEL-5): a store becomes public (`stores.status =
 * active`) only when its billing is secured. `OnboardingService.goLive` is the
 * only merchant-reachable writer of that status; super-admin status writes
 * (`PATCH /admin/stores/:id/status`, `PATCH /stores/:id/status`) are the
 * platform-operator override and are not gated.
 *
 * A store may go live when ONE of these holds:
 *  - a hidden admin-granted plan (`comped` / `founding_free`), or status `comped`;
 *  - an unexpired trial with a saved card (nothing charged yet, charged day 15);
 *  - an unexpired trial whose merchant chose InstaPay (paid by transfer at the
 *    trial end, confirmed by a super-admin; Ruling EBDA-FUNNEL-9);
 *  - an `active` subscription paid by card or by a recorded manual payment;
 *  - an ADDITIONAL store whose owner holds a qualifying subscription on a plan
 *    that allows more than one store (Business) — that plan pays for it.
 * AND the store is within the owner's store allowance (oldest stores first).
 */
import { withStore, withUser } from '@ebda/database';
import { AppError } from '../../middleware/error-handler';
import { isGrantedPlan } from './period';
import { resolveTrialCardMode, type TrialCardMode } from './index';
import { storeRank } from './account.service';

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

const MESSAGES: Record<Exclude<GateVerdict, { ok: true }>['code'], string> = {
  PAYMENT_METHOD_REQUIRED: 'Choose InstaPay (or add a payment card) before your store goes live',
  TRIAL_EXPIRED: 'Your trial has ended; choose a plan and pay to go live',
  NO_SUBSCRIPTION: 'This store has no plan yet',
  STORE_LIMIT_REACHED: 'Your plan does not include another live store; upgrade to Business',
};
const MESSAGES_AR: Record<keyof typeof MESSAGES, string> = {
  PAYMENT_METHOD_REQUIRED: 'أضف بطاقة دفع أو اختر إنستاباي قبل نشر متجرك',
  TRIAL_EXPIRED: 'انتهت فترة التجربة؛ اختر باقة وادفع لنشر المتجر',
  NO_SUBSCRIPTION: 'لا توجد باقة لهذا المتجر بعد',
  STORE_LIMIT_REACHED: 'باقتك لا تشمل متجرًا منشورًا إضافيًا؛ قم بالترقية إلى الأعمال',
};

function gateError(code: keyof typeof MESSAGES): AppError {
  return new AppError(402, code, MESSAGES[code], {
    messageEn: MESSAGES[code],
    messageAr: MESSAGES_AR[code],
    upgradeTo: code === 'STORE_LIMIT_REACHED' ? 'business' : null,
  });
}

export async function assertStoreMayGoLive(storeId: string, now: Date = new Date()) {
  // Store allowance first: a store beyond the owner's plan never goes live.
  const { rank, allowance } = await storeRank(storeId);
  if (rank >= allowance) throw gateError('STORE_LIMIT_REACHED');
  const verdict = await ownVerdict(storeId, now);
  if (verdict.ok) return verdict;

  // An additional store (rank > 0, within an allowance > 1) rides the owner's
  // OLDEST store — the billing parent whose plan granted the allowance.
  if (rank > 0) {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { ownerId: true },
      })
    );
    // The owner's other stores are outside this store's scope: read them AS the owner.
    const ownerId = store?.ownerId;
    const parent = ownerId
      ? await withUser(ownerId, tx =>
          tx.store.findFirst({
            where: { ownerId, deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          })
        )
      : null;
    if (parent && parent.id !== storeId && (await ownVerdict(parent.id, now)).ok) {
      return { ok: true as const, reason: 'paid_active' as const };
    }
  }
  throw gateError(verdict.code);
}

async function ownVerdict(storeId: string, now: Date): Promise<GateVerdict> {
  const own = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId } })
  );
  return goLiveVerdict(own, resolveTrialCardMode(), now);
}
