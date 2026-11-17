import { AppError } from '../middleware/error-handler';
import {
  erasureEnabled,
  runErasure,
  type ErasureEnv,
  type ErasureSurface,
  type LedgerEntry,
  type MerchantSubject,
} from '../cf/erasure';
import logger from '../lib/logger';
import { liveBilledStoresOf, OWNER_HAS_BILLED_STORE_MESSAGE_AR } from './account-closure-guard';

/**
 * Merchant / staff account closure (M-024, Ruling M024-1): the TRIGGER for the PDPL erasure job (`cf/erasure/job.ts`),
 * which had no caller. Flag-gated by `PDPL_CF_ERASURE_ENABLED`: while the flag is off the request is recorded (an audit
 * row, so it is never lost and ops can run it the day the flag is on), ops is alerted, and the caller gets a 503
 * `ERASURE_NOT_ENABLED` with an honest message; nothing is erased (S3, 2026-11-12 audit: it used to answer 202 and the
 * UI told the user the account was closed while every byte of PII stayed).
 *
 * Order, all before anything is erased: (1) an owner with a live billed store is refused (OFFBOARD-1, the same predicate
 * as DELETE /auth/me); (2) the job's own StoreDO gate refuses while money is in flight (the job stops before identity,
 * media or CI data is touched). A staff user (owns no store) goes through the identity surface only.
 */
export interface ClosureDeps {
  env: ErasureEnv;
  ownedStoreIds(userId: string): Promise<string[]>;
  liveBilledStoresOf?(userId: string): Promise<string[]>;
  /** Every surface the job runs for an owner (store-do first is enforced by the job). */
  ownerSurfaces(): ErasureSurface[];
  /** The identity surface alone (a staff user has no store of their own). */
  staffSurfaces(): ErasureSurface[];
  /** Records the request when the flag is off. */
  recordRequest(userId: string, requestId: string, stores: string[]): Promise<void>;
  run?: typeof runErasure;
  alert?: (title: string, body: string) => Promise<unknown>;
}

export type ClosureOutcome = { status: 'erased'; stores: string[]; ledger: LedgerEntry[] };

const MONEY_IN_FLIGHT_AR =
  'مش هينفع نقفل الحساب دلوقتي لأن فيه فلوس لسه في الطريق على متجرك (طلبات أو استردادات). استنى لما تخلص وجرّب تاني.';
const ERASURE_NOT_ENABLED_MESSAGE =
  'طلب قفل الحساب اتسجل عندنا، بس الحذف لسه ماتفعّلش، فحسابك وبياناتك لسه موجودين. هنكمّل الطلب مع الدعم. / Your closure request was recorded, but account erasure is not enabled yet: your account and data still exist. Support will complete it.';
const FAILED_AR = 'قفل الحساب ماكملش. اتسجل عندنا وهنراجعه مع الدعم.';

export async function closeNonCustomerAccount(
  input: { userId: string; requestId: string },
  deps: ClosureDeps
): Promise<ClosureOutcome> {
  const stores = await deps.ownedStoreIds(input.userId);
  const billed = await (deps.liveBilledStoresOf ?? liveBilledStoresOf)(input.userId);
  if (billed.length > 0) {
    throw new AppError(409, 'OWNER_HAS_LIVE_BILLED_STORE', OWNER_HAS_BILLED_STORE_MESSAGE_AR);
  }
  if (!erasureEnabled(deps.env)) {
    await deps.recordRequest(input.userId, input.requestId, stores);
    logger.error(
      { requestId: input.requestId, stores: stores.length, rule: 'S3' },
      'account closure requested but PDPL_CF_ERASURE_ENABLED is off: nothing erased, request recorded'
    );
    if (deps.alert) {
      await deps
        .alert(
          'account closure NOT erased: PDPL erasure flag off',
          `A merchant/staff closure was requested (request ${input.requestId}, ${stores.length} store(s)). PDPL_CF_ERASURE_ENABLED is not "true", so nothing was erased and the user was told so (503 ERASURE_NOT_ENABLED). Run it by hand once the flag is on.`
        )
        .catch(() => undefined);
    }
    throw new AppError(503, 'ERASURE_NOT_ENABLED', ERASURE_NOT_ENABLED_MESSAGE);
  }
  const run = deps.run ?? runErasure;
  const ledger: LedgerEntry[] = [];
  if (stores.length === 0) {
    // staff: the identity record only. The request id is the subject's own, so a replay short-circuits on the ledger.
    const subject: MerchantSubject = {
      kind: 'merchant',
      requestId: input.requestId,
      storeId: '',
      ownerUserId: input.userId,
    };
    const e = await run(deps.env, deps.staffSurfaces(), subject, { alert: deps.alert });
    ledger.push(e);
  } else {
    for (const storeId of stores) {
      const subject: MerchantSubject = {
        kind: 'merchant',
        requestId: `${input.requestId}:${storeId}`,
        storeId,
        ownerUserId: input.userId,
      };
      ledger.push(await run(deps.env, deps.ownerSurfaces(), subject, { alert: deps.alert }));
    }
  }
  const failed = ledger.find(e => e.status !== 'done');
  if (failed) {
    const refused = failed.surfaces.some(s => /money in flight/.test(s.note ?? ''));
    throw new AppError(
      refused ? 409 : 503,
      refused ? 'MONEY_IN_FLIGHT' : 'CLOSURE_INCOMPLETE',
      refused ? MONEY_IN_FLIGHT_AR : FAILED_AR
    );
  }
  return { status: 'erased', stores, ledger };
}
