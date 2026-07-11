/**
 * Right-to-erasure (GDPR Art. 17 / Kuwait Law 13/2023 Art. 17) propagation
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
 *     this is empty for real customer erasures today (see below).
 *   - PostHog: deletes the person, env-gated behind
 *     `POSTHOG_PERSONAL_API_KEY` (not configured anywhere in this repo
 *     today — see `deletePostHogPerson`).
 *   - Meta / TikTok / Snap CAPI: intentionally NOT handled here. CAPI
 *     receives pseudonymized (SHA-256 hashed email/phone) conversion
 *     EVENTS, not a queryable per-user profile FWB can delete via API —
 *     see docs/privacy/data-map.md "Deletion & backups" for the full
 *     reasoning and the providers' own data-subject-request contacts.
 */

import logger from '../lib/logger';
import { config } from '../config';

const ONESIGNAL_PLAYERS_ENDPOINT = 'https://onesignal.com/api/v1/players';

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
  if (playerIds.length === 0) return;

  if (!config.onesignalAdminAppId || !config.onesignalAdminRestApiKey) {
    logger.warn(
      { count: playerIds.length },
      '[privacy-propagation] OneSignal admin app not configured — skipping player deletion'
    );
    return;
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
 * NOT LIVE TODAY — env-gated, warns and no-ops rather than faking success:
 *
 *   1. FWB's storefront PostHog init (`PostHogProvider.tsx`) only ever
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
 * PostHog `distinct_id` this function looks up.
 */
export async function deletePostHogPerson(userId: string): Promise<void> {
  const { posthogPersonalApiKey: apiKey, posthogProjectId: projectId, posthogHost } = config;

  if (!apiKey || !projectId) {
    logger.warn(
      '[privacy-propagation] POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID not set — skipping PostHog person deletion (see docs/privacy/data-map.md)'
    );
    return;
  }

  const authHeader = { Authorization: `Bearer ${apiKey}` };

  // Best-effort lookup: userId is used as the distinct_id, which only
  // resolves once a future `posthog.identify(userId)` call links the two
  // (see caveat above). An unmatched distinct_id returns zero results,
  // which is treated as "nothing to delete", not an error.
  const searchRes = await fetch(
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
  const deleteRes = await fetch(
    `${posthogHost}/api/projects/${encodeURIComponent(projectId)}/persons/${encodeURIComponent(person.id)}/?delete_events=true`,
    { method: 'DELETE', headers: authHeader }
  );
  if (!deleteRes.ok && deleteRes.status !== 404) {
    const body = await deleteRes.text().catch(() => '');
    throw new Error(`PostHog person delete failed (${deleteRes.status}): ${body}`);
  }
}
