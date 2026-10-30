import type { JobDef } from '../../jobs/types';
import {
  deleteOneSignalPlayers,
  deletePostHogPerson,
  summarizePropagationFailures,
} from '../../../services/privacy-propagation.service';
import logger from '../../logger';
import { cfBindings } from '../../../cf/bindings';
import {
  eraseCiBuyerInStore,
  eraseCiForOrders,
  type CiBucket,
  type EraseMode,
} from '../../ci/erase';
import { inngest } from '../client';
import { storeRepo } from '../../repo-factory';

/**
 * Third-party Right-to-Erasure propagation (GDPR Art. 17 and applicable
 * GCC data-protection law — see docs/privacy/data-map.md).
 *
 * `AuthService.eraseAccount` anonymizes Neon in a single transaction and
 * that MUST succeed on its own — this consumer runs entirely AFTER that
 * transaction has already committed and the customer already got their
 * 200 response, via the `account/erased` event it fires. A failure here
 * can never roll back the erasure or block the user; it only means a
 * third-party copy of their data persists a little longer, which is why
 * every step below is independently retried by Inngest and logged rather
 * than escalated back into the request path.
 *
 * Each side effect is its own `step.run` so a flaky OneSignal response
 * doesn't cancel the PostHog call, matching the fan-out pattern in
 * `order-created.ts`.
 */
export const accountErasedPropagation: JobDef = inngest.createFunction(
  {
    id: 'account-erased-propagation',
    name: 'Account erased — third-party deletion propagation (OneSignal, PostHog)',
    retries: 2,
    triggers: [{ event: 'account/erased' }],
  },
  async ({ event, step }) => {
    const { userId, oneSignalPlayerIds, ciProven, ciScope, storeId } = event.data;
    // (the CI second pass is its own function, ci-erasure-second-pass.ts: a failing sibling step here must never skip it)

    if (!userId) {
      logger.warn({ event: event.name }, 'account/erased fired without userId — skipping');
      return;
    }

    const results = await Promise.allSettled([
      step.run('delete-onesignal-players', () => deleteOneSignalPlayers(oneSignalPlayerIds ?? [])),
      step.run('delete-posthog-person', () => deletePostHogPerson(userId)),
      // Customer Intelligence (PDPL): the buyer's rows in R2 `ebda-ci` and their index entries. Analytics
      // Engine holds no buyer key, so there is nothing to erase there. Not a Worker (Node)? no bucket.
      step.run('erase-ci-outcomes', () => eraseCiOutcomes(userId, ciScope, ciProven)),
    ]);

    // Re-throw (aggregated) if a step ultimately failed after Inngest's
    // per-step retries, so `alerts-failure-watch` can dead-letter it —
    // same rationale as order-created.ts. This only affects Inngest's own
    // observability; the erase response the customer received is long
    // since sent and is never touched by this function.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length > 0) {
      rejected.forEach(r =>
        // Never log PII — userId is an opaque identifier, no email/name here.
        logger.error({ err: r.reason, userId }, 'account/erased propagation step failed')
      );
      // Name WHICH provider(s) failed, and whether it's the expected
      // "not configured yet" case vs a genuine outage, directly in the
      // message that becomes the alert body — see
      // `summarizePropagationFailures`'s doc comment for why.
      const summary = summarizePropagationFailures(rejected.map(r => r.reason));
      throw new AggregateError(
        rejected.map(r => r.reason),
        `account-erased-propagation: ${rejected.length}/${results.length} step(s) failed (${summary})`
      );
    }
    // Only now, with every propagation done, may a DO store drop the saved erasure scope a re-run would need.
    if (typeof storeId === 'string' && storeId)
      await step.run('finalize-do-erasure', () => finalizeDoErasure(storeId, userId));
  }
);

/**
 * Erases the account's CI rows. `scope` = the account's own orders in its store (always); `proven` = buyer
 * keys of a phone the account PROVED it holds (WA-CONSENT-1), erased in THAT store only. Throws when any
 * row survives (so the job retries and pages). Tombstones are written first (lib/ci/erase.ts).
 */
export async function eraseCiOutcomes(
  requestId: string,
  scope:
    | { storeId?: string; orderIds?: string[]; buyerKeys?: string[]; sinceDay?: string }
    | undefined,
  proven?: { storeId: string; buyerKeys: string[] },
  bucket: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined,
  mode: EraseMode = 'index'
): Promise<{ erased: number }> {
  void requestId;
  const hasScope = !!scope?.storeId && (scope.orderIds?.length ?? 0) > 0;
  const hasProven = !!proven && proven.buyerKeys.length > 0;
  if (!hasScope && !hasProven) return { erased: 0 };
  if (!bucket) {
    if (cfBindings()) throw new Error('CI_BUCKET binding missing: CI rows were not erased');
    return { erased: 0 };
  }
  let erased = 0;
  if (hasScope) {
    const r = await eraseCiForOrders(
      bucket,
      { storeId: scope!.storeId!, orderIds: scope!.orderIds!, buyerKeys: scope!.buyerKeys ?? [] },
      mode,
      scope!.sinceDay
    );
    if (r.remaining > 0)
      throw new Error(`CI erasure left ${r.remaining} row(s) of the account's orders`);
    erased += r.erased;
  }
  if (hasProven) {
    const r = await eraseCiBuyerInStore(bucket, proven!, mode, scope?.sinceDay);
    if (r.remaining > 0)
      throw new Error(`CI erasure left ${r.remaining} row(s) for a proven buyer key`);
    erased += r.erased;
  }
  return { erased };
}

/** Drops the DO's saved erasure scope (ids and hashes kept only so a failed attempt can be finished). No-op off the DO. */
export async function finalizeDoErasure(storeId: string, userId: string): Promise<void> {
  const money = (await storeRepo(storeId)).money;
  if (money) await money.finalizeErasure({ userId });
}
