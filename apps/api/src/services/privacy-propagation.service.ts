/**
 * Right-to-erasure (GDPR Art. 17 and applicable GCC data-protection law —
 * see docs/privacy/data-map.md) propagation
 * to third parties that hold a copy of the user's personal data outside
 * Neon Postgres.
 *
 * `AuthService.eraseAccount` anonymizes the primary DB row set inside a
 * single transaction — that transaction MUST succeed on its own merits,
 * regardless of what happens here. Everything in this file is called from
 * `lib/inngest/functions/account-erased-propagation.ts`, AFTER the erase
 * transaction has already committed, so a slow or failing third-party call
 * can never roll back the anonymization or block the response the customer
 * already received.
 *
 * Coverage:
 *   - OneSignal: best-effort delete of any known player/subscription for
 *     the user. See the caveat on `deleteOneSignalPlayers` — in practice
 *     this is empty for real customer erasures today (see below), so it's
 *     a genuine no-op rather than a missing-credential failure.
 *   - PostHog: deletes the person, env-gated behind
 *     `POSTHOG_PERSONAL_API_KEY` (not configured anywhere in this repo
 *     today — see `deletePostHogPerson`). A missing credential WARNS and
 *     no-ops, because no person is keyed by our userId until
 *     `posthog.identify()` is wired; it fails loud
 *     (`PropagationNotConfiguredError`, dead-lettered via
 *     `alerts-failure-watch`) only when `POSTHOG_ERASURE_REQUIRED=true`.
 *   - Meta / TikTok CAPI: no per-subject deletion API exists (see
 *     docs/privacy/data-map.md "Deletion & backups" for the full
 *     reasoning and the providers' own data-subject-request contacts) —
 *     instead, `order-capi-conversion.ts` SUPPRESSES the event entirely
 *     for any order whose customer has since been erased (detected via
 *     the `{ anonymized: true }` shipping-address marker `eraseAccount`
 *     writes), so an erased subject never generates a fresh CAPI event.
 *     Snap/Twitter/Pinterest never received server-side CAPI events to
 *     begin with (client-side pixels only — see data-map.md §3).
 */

import logger from '../lib/logger';
import { config } from '../config';
import { fetchWithTimeout } from '../lib/fetch-timeout';

const ONESIGNAL_PLAYERS_ENDPOINT = 'https://onesignal.com/api/v1/players';

/**
 * Thrown when a third-party erasure-propagation target has personal data
 * to delete but the credential needed to reach it isn't configured.
 *
 * This is NOT the same as "nothing to delete" (e.g. `deleteOneSignalPlayers`
 * with an empty `playerIds` array, which is a genuine no-op and returns
 * normally) — it's "there IS a copy of this person's data at this
 * provider, and we could not attempt to remove it." Per the repo's
 * fail-loud-not-silent-no-op rule, this must surface as a FAILED
 * propagation step (caught by `Promise.allSettled` in
 * `account-erased-propagation.ts`, which re-throws so
 * `alerts-failure-watch` dead-letters it) rather than a quiet success that
 * leaves the third-party copy in place indefinitely.
 */
export class PropagationNotConfiguredError extends Error {
  constructor(
    public readonly provider: string,
    message: string
  ) {
    super(message);
    this.name = 'PropagationNotConfiguredError';
  }
}

/**
 * Turn a list of rejected propagation-step reasons into a short,
 * human-readable summary naming which provider failed and why — used as
 * the Inngest `AggregateError` message, which becomes the Telegram alert
 * body in `alerts-failure-watch.ts`. `sendAlert` already throttles repeats
 * of the same (level, title) to one per 5 minutes, but that title is
 * generic per Inngest function ("inngest function failed: X"); without a
 * distinguishing body, an operator reading the throttled alert can't tell
 * "PostHog is expectedly unconfigured" from "OneSignal is actually down" —
 * which would turn the fail-loud fix into noise that gets muted just as
 * silently as the no-op it replaced.
 */
export function summarizePropagationFailures(reasons: unknown[]): string {
  return reasons
    .map(reason => {
      if (reason instanceof PropagationNotConfiguredError) {
        return `${reason.provider}: not-configured`;
      }
      if (reason instanceof Error) return reason.message;
      return 'unknown error';
    })
    .join('; ');
}

/**
 * Delete each known OneSignal player/subscription for an erased user.
 *
 * CAVEAT (read before assuming this closes storefront push deletion):
 * `OneSignalSubscription` DB rows are only ever written by the ADMIN app's
 * subscribe flow (`POST /admin/notifications/onesignal/subscribe`, wired
 * from `apps/admin/src/components/OneSignalInit.tsx`), which explicitly
 * skips `role === 'customer'` devices. The storefront's own OneSignal init
 * (`apps/web/src/components/OneSignalStorefrontInit.tsx`) only tags a
 * subscribed device with the store id — it never captures or persists a
 * per-customer player id server-side. `AuthService.eraseAccount` is
 * customer-only (admin accounts can't self-erase via that endpoint), so
 * `playerIds` is empty for essentially every real customer erasure today.
 *
 * This is still wired for real (not stubbed) because it's the structurally
 * correct hook: it deletes whatever rows genuinely exist for the given
 * user, using the same admin-app credentials those rows were created
 * under, and it will start doing real work the moment a future feature
 * ties a storefront customer to a captured OneSignal player id. Until
 * then, the local DB rows removed inside `eraseAccount`'s transaction are
 * the only server-side record that ever existed for a customer.
 */
export async function deleteOneSignalPlayers(playerIds: string[]): Promise<void> {
  // Genuine no-op: there is nothing to delete, so there is nothing to fail
  // at. Distinct from the missing-credential case below.
  if (playerIds.length === 0) return;

  if (!config.onesignalAdminAppId || !config.onesignalAdminRestApiKey) {
    logger.error(
      { count: playerIds.length },
      '[privacy-propagation] OneSignal admin app not configured — ' +
        `${playerIds.length} player(s) could NOT be deleted (fail-loud, not a silent no-op)`
    );
    throw new PropagationNotConfiguredError(
      'onesignal',
      `OneSignal admin app not configured — ${playerIds.length} player(s) left undeleted`
    );
  }

  const appId = config.onesignalAdminAppId;
  const restApiKey = config.onesignalAdminRestApiKey;

  const results = await Promise.allSettled(
    playerIds.map(async playerId => {
      const res = await fetch(
        `${ONESIGNAL_PLAYERS_ENDPOINT}/${encodeURIComponent(playerId)}?app_id=${encodeURIComponent(appId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Key ${restApiKey}` },
        }
      );
      // 404 = already gone (device unsubscribed, or a previous erase retry
      // already deleted it) — treat as success, not a failure to retry.
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => '');
        throw new Error(`OneSignal player delete failed (${res.status}): ${body}`);
      }
    })
  );

  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    // playerId is an opaque OneSignal-issued identifier, not PII — safe to
    // count in logs, but we still never log the raw id or any user field.
    logger.error(
      { failedCount: failed.length, totalCount: playerIds.length },
      '[privacy-propagation] one or more OneSignal player deletions failed'
    );
    throw new AggregateError(
      failed.map(f => f.reason),
      `deleteOneSignalPlayers: ${failed.length}/${playerIds.length} deletion(s) failed`
    );
  }
}

interface PostHogPersonSearchResult {
  results?: Array<{ id: string }>;
}

/**
 * Delete the user's PostHog person record.
 *
 * NOT LIVE TODAY — env-gated, and now FAILS LOUD rather than silently
 * no-opping when the credential is missing (2026-09-22 — a silent
 * `return` here meant a PostHog person copy of an "erased" customer's
 * data survived indefinitely while every log line said the erasure
 * succeeded):
 *
 *   1. Ebda's storefront PostHog init (`PostHogProvider.tsx`) only ever
 *      holds the PUBLIC project key (`NEXT_PUBLIC_POSTHOG_KEY`) client-side.
 *      Deleting a person requires a PERSONAL API key with person-level
 *      write scope — that key must never reach the browser, and no
 *      `POSTHOG_PERSONAL_API_KEY` is configured anywhere in this repo
 *      today.
 *   2. Even with that key configured, the codebase never actually calls
 *      `posthog.identify(userId)` — the comment in `PostHogProvider.tsx`
 *      describes the intent, but the call was never added. Without it,
 *      PostHog only knows the visitor by an anonymous, randomly-generated
 *      `distinct_id` that the server never learns — so there is no
 *      reliable way to look the person up by Force `userId` yet.
 *
 * To make this live: set `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID`,
 * AND add `posthog.identify(user.id)` at login so `userId` really is the
 * PostHog `distinct_id` this function looks up — then set
 * `POSTHOG_ERASURE_REQUIRED=true` so a missing credential fails loud again.
 *
 * Until identify() exists there is no person keyed by our `userId`, so an
 * unconfigured PostHog is a documented WARN + no-op rather than a thrown
 * `PropagationNotConfiguredError`. It used to throw, which dead-lettered
 * `account-erased-propagation` and raised a P1 alert on EVERY erasure
 * (up to 200 per monthly retention-cron run) for a person that provably
 * cannot exist — noise that trains operators to mute the very channel a real
 * OneSignal outage would use. See the branch below for the full reasoning.
 */
export async function deletePostHogPerson(userId: string): Promise<void> {
  const { posthogPersonalApiKey: apiKey, posthogProjectId: projectId, posthogHost } = config;

  if (!apiKey || !projectId) {
    // `PropagationNotConfiguredError` means, by its own contract above,
    // "there IS a copy of this person's data here and we could not reach it".
    // For PostHog that precondition does NOT hold: nothing in this repo calls
    // `posthog.identify(userId)` (verified 2026-09-23 — every occurrence is a
    // comment), so PostHog knows visitors only by an anonymous distinct_id the
    // server never learns. There is no person keyed by our userId to delete.
    //
    // The proof is in this function's own body: when the credential IS set and
    // the distinct_id matches nothing, it logs "nothing to delete" and returns
    // normally. Unconfigured cannot hold MORE data than configured-and-
    // unmatched, yet it was the only branch that threw.
    //
    // Cost of that asymmetry: `account-erased-propagation` (retries: 2)
    // exhausted every attempt on EVERY erasure, so `alerts-failure-watch`
    // raised a P1 per erase — and the monthly retention cron erases up to
    // USER_ANONYMIZE_BATCH_CAP (200) subjects per run. A channel that cries
    // wolf on every single erasure gets muted, and then a REAL OneSignal
    // outage or PostHog 500 is invisible. Fail-loud that cannot distinguish
    // itself from noise is not fail-loud.
    //
    // So: warn (durable, greppable) instead of throwing — UNLESS someone has
    // declared that PostHog really does hold identified data, in which case
    // the original fail-loud behaviour is exactly right.
    if (config.posthogErasureRequired) {
      logger.error(
        '[privacy-propagation] POSTHOG_ERASURE_REQUIRED=true but ' +
          'POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID are not set — PostHog person deletion could NOT be attempted'
      );
      throw new PropagationNotConfiguredError(
        'posthog',
        'POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID not set while POSTHOG_ERASURE_REQUIRED=true — PostHog person deletion not attempted'
      );
    }
    logger.warn(
      { userId },
      '[privacy-propagation] PostHog person deletion SKIPPED — no POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID, ' +
        'and posthog.identify(userId) is never called so no person is keyed by this userId. ' +
        'Set POSTHOG_ERASURE_REQUIRED=true (with the credentials) to make this a hard failure once identify() is wired.'
    );
    return;
  }

  const authHeader = { Authorization: `Bearer ${apiKey}` };

  // Best-effort lookup: userId is used as the distinct_id, which only
  // resolves once a future `posthog.identify(userId)` call links the two
  // (see caveat above). An unmatched distinct_id returns zero results,
  // which is treated as "nothing to delete", not an error.
  const searchRes = await fetchWithTimeout(
    `${posthogHost}/api/projects/${encodeURIComponent(projectId)}/persons/?distinct_id=${encodeURIComponent(userId)}`,
    { headers: authHeader }
  );
  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => '');
    throw new Error(`PostHog person lookup failed (${searchRes.status}): ${body}`);
  }
  const found = (await searchRes.json()) as PostHogPersonSearchResult;
  const person = found.results?.[0];
  if (!person) {
    logger.info(
      '[privacy-propagation] no matching PostHog person for erased user — nothing to delete'
    );
    return;
  }

  // ?delete_events=true so the person's captured behavioural events are purged
  // too — deleting only the person shell leaves the events, which re-materialize
  // the person on the next ingested event (incomplete GDPR Art.17 erasure).
  const deleteRes = await fetchWithTimeout(
    `${posthogHost}/api/projects/${encodeURIComponent(projectId)}/persons/${encodeURIComponent(person.id)}/?delete_events=true`,
    { method: 'DELETE', headers: authHeader }
  );
  if (!deleteRes.ok && deleteRes.status !== 404) {
    const body = await deleteRes.text().catch(() => '');
    throw new Error(`PostHog person delete failed (${deleteRes.status}): ${body}`);
  }
}
