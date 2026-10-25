import type { InngestFunction } from 'inngest';
import {
  deleteOneSignalPlayers,
  deletePostHogPerson,
  summarizePropagationFailures,
} from '../../../services/privacy-propagation.service';
import logger from '../../logger';
import { cfBindings } from '../../../cf/bindings';
import { eraseCiBuyerKey, eraseCiForOrders, type CiBucket } from '../../ci/erase';
import { inngest } from '../client';

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
export const accountErasedPropagation: InngestFunction.Any = inngest.createFunction(
  {
    id: 'account-erased-propagation',
    name: 'Account erased — third-party deletion propagation (OneSignal, PostHog)',
    retries: 2,
    triggers: [{ event: 'account/erased' }],
  },
  async ({ event, step }) => {
    const { userId, oneSignalPlayerIds, ciBuyerKeys, ciScope } = event.data;

    if (!userId) {
      logger.warn({ event: event.name }, 'account/erased fired without userId — skipping');
      return;
    }

    const results = await Promise.allSettled([
      step.run('delete-onesignal-players', () => deleteOneSignalPlayers(oneSignalPlayerIds ?? [])),
      step.run('delete-posthog-person', () => deletePostHogPerson(userId)),
      // Customer Intelligence (PDPL): the buyer's rows in R2 `ebda-ci` and their index entries. Analytics
      // Engine holds no buyer key, so there is nothing to erase there. Not a Worker (Node)? no bucket.
      step.run('erase-ci-outcomes', () => eraseCiOutcomes(userId, ciScope, ciBuyerKeys ?? [])),
    ]);

    // Customer Intelligence: a second pass after the queue's retry window. A tombstone already blocks
    // in-flight events; this removes anything a replay slipped in before the tombstone landed.
    if (ciScope?.orderIds?.length || ciBuyerKeys?.length) {
      await step.sleep('ci-erasure-settle', '2h');
      await step.run('erase-ci-outcomes-second-pass', () =>
        eraseCiOutcomes(userId, ciScope, ciBuyerKeys ?? [])
      );
    }

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
  }
);

/**
 * Erases the account's CI rows. `scope` = the account's own orders in its store (always); `provenKeys` =
 * buyer keys of a phone the account PROVED it holds (WA-CONSENT-1), erased across every store. Throws
 * when any row survives (so the job retries and pages). Tombstones are written first (lib/ci/erase.ts).
 */
export async function eraseCiOutcomes(
  requestId: string,
  scope: { storeId?: string; orderIds?: string[]; buyerKeys?: string[] } | undefined,
  provenKeys: string[] = [],
  bucket: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined
): Promise<{ erased: number }> {
  const hasScope = !!scope?.storeId && (scope.orderIds?.length ?? 0) > 0;
  if (!hasScope && provenKeys.length === 0) return { erased: 0 };
  if (!bucket) {
    if (cfBindings()) throw new Error('CI_BUCKET binding missing: CI rows were not erased');
    return { erased: 0 };
  }
  let erased = 0;
  if (hasScope) {
    const r = await eraseCiForOrders(bucket, {
      storeId: scope!.storeId!,
      orderIds: scope!.orderIds!,
      buyerKeys: scope!.buyerKeys ?? [],
    });
    if (r.remaining > 0)
      throw new Error(`CI erasure left ${r.remaining} row(s) of the account's orders`);
    erased += r.erased;
  }
  for (const buyerKey of provenKeys) {
    const r = await eraseCiBuyerKey(bucket, buyerKey, requestId);
    if (r.remaining > 0)
      throw new Error(`CI erasure left ${r.remaining} row(s) for a proven buyer key`);
    erased += r.erased;
  }
  return { erased };
}
