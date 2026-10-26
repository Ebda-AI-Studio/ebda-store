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
import { withStore } from '@ebda/database';
import { AppError } from '../../middleware/error-handler';
import { goLiveVerdict, type GateVerdict } from './go-live-verdict';
import { resolveTrialCardMode } from './index';
import { childStoreCoverage, storeRank } from './account.service';

export { goLiveVerdict } from './go-live-verdict';
export type { GateSub, GateVerdict } from './go-live-verdict';

const MESSAGES: Record<Exclude<GateVerdict, { ok: true }>['code'], string> = {
  PAYMENT_METHOD_REQUIRED: 'Choose InstaPay (or add a payment card) before your store goes live',
  TRIAL_EXPIRED: 'Your trial has ended; choose a plan and pay to go live',
  NO_SUBSCRIPTION: 'This store has no plan yet',
  STORE_LIMIT_REACHED: 'Your plan does not include another live store; upgrade to Business',
};
const MESSAGES_AR: Record<keyof typeof MESSAGES, string> = {
  PAYMENT_METHOD_REQUIRED: 'ضيف كارت دفع أو اختار إنستاباي قبل ما تنشر متجرك',
  TRIAL_EXPIRED: 'فترة التجربة خلصت؛ اختار باقة وادفع عشان تنشر المتجر',
  NO_SUBSCRIPTION: 'المتجر ده لسه مالوش باقة',
  STORE_LIMIT_REACHED: 'باقتك مفيهاش متجر منشور زيادة؛ اعمل ترقية لباقة الأعمال',
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
  if (rank > 0) {
    // A CHILD store is decided ONLY by its billing parent (billing-parent.ts, fail closed):
    // its own subscription row is never consulted, so a stale row cannot keep it live after
    // the parent stops paying (EBDA-FUNNEL-18).
    const cover = await childStoreCoverage(storeId, now);
    if (cover.covered) return { ok: true as const, reason: 'paid_active' as const };
    throw gateError(cover.parentVerdictCode ?? 'NO_SUBSCRIPTION');
  }
  const verdict = await ownVerdict(storeId, now);
  if (verdict.ok) return verdict;
  throw gateError(verdict.code);
}

async function ownVerdict(storeId: string, now: Date): Promise<GateVerdict> {
  const own = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId } })
  );
  return goLiveVerdict(own, resolveTrialCardMode(), now);
}
