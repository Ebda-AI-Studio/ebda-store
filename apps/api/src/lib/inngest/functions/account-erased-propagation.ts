import type { InngestFunction } from 'inngest';
import {
  deleteOneSignalPlayers,
  deletePostHogPerson,
} from '../../../services/privacy-propagation.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Third-party Right-to-Erasure propagation (GDPR Art. 17 / Kuwait Law
 * 13/2023 Art. 17).
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
    const { userId, oneSignalPlayerIds } = event.data;

    if (!userId) {
      logger.warn({ event: event.name }, 'account/erased fired without userId — skipping');
      return;
    }

    const results = await Promise.allSettled([
      step.run('delete-onesignal-players', () => deleteOneSignalPlayers(oneSignalPlayerIds ?? [])),
      step.run('delete-posthog-person', () => deletePostHogPerson(userId)),
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
      throw new AggregateError(
        rejected.map(r => r.reason),
        `account-erased-propagation: ${rejected.length}/${results.length} step(s) failed`
      );
    }
  }
);
