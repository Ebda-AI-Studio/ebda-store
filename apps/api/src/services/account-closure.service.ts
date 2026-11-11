import { AppError } from '../middleware/error-handler';
import {
  erasureEnabled,
  runErasure,
  type ErasureEnv,
  type ErasureSurface,
  type LedgerEntry,
  type MerchantSubject,
} from '../cf/erasure';
import { liveBilledStoresOf, OWNER_HAS_BILLED_STORE_MESSAGE_AR } from './account-closure-guard';

/**
 * Merchant / staff account closure (M-024, Ruling M024-1): the TRIGGER for the PDPL erasure job (`cf/erasure/job.ts`),
 * which had no caller. Flag-gated by `PDPL_CF_ERASURE_ENABLED`: while the flag is off the request is recorded (an audit
 * row, so it is never lost and ops can run it the day the flag is on) and answered `recorded`; nothing is erased.
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

export type ClosureOutcome =
  | { status: 'recorded'; stores: string[] }
  | { status: 'erased'; stores: string[]; ledger: LedgerEntry[] };

const MONEY_IN_FLIGHT_AR =
  'مش هينفع نقفل الحساب دلوقتي لأن فيه فلوس لسه في الطريق على متجرك (طلبات أو استردادات). استنى لما تخلص وجرّب تاني.';
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
    return { status: 'recorded', stores };
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
