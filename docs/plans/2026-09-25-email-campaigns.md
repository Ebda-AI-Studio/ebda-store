# D2 — Email Campaigns (spec + plan)

_2026-09-25 · branch `feat/d2-email-campaigns` · feature key `email_campaigns`_

## Finish line

- **What must work:** a merchant on a store where `email_campaigns` is ON can write a bilingual
  campaign, see how many consented people it will reach, send a test to themselves, and send it
  now or schedule it. It goes out through Inngest, one email per recipient, throttled, idempotent
  under retry, capped per store per 24h, and every email carries a working unsubscribe.
- **Exercised to prove it:** unit tests for the audience builder, the send job, the unsubscribe
  token, and the feature-off route path, plus mutation proof of the consent filter and the
  idempotency guard. `tsc` for api/admin/web/shared, lint, and the unit suite.
- **Must NOT change:** no store gets the feature by default (it is in no plan baseline), no
  migration sends, backfills or schedules anything, and no transactional email path changes.
- **Done =** the PR is open against `main` with those checks green, and it says what could not be
  verified (a real send through Resend).

## Current state (what exists)

| Thing                         | Where                                                | Relevance                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature key `email_campaigns` | `packages/shared/src/features.ts`                    | registered, `hidden: true`, **in no `PLAN_BASELINE`** → resolves OFF for every store unless a super-admin `StoreFeature` override turns it on (`feature.service.ts#rowsToMap`). Only `super_admin` can write overrides (`feature.routes.ts`). |
| Newsletter subscribers        | `NewsletterSubscriber` (`newsletter_subscribers`)    | the only explicit email-marketing opt-in in the schema. Email is lowercased on write (`public.routes.ts /newsletter/subscribe`), `isActive` + `unsubscribedAt` track consent. No double opt-in field exists.                                  |
| Customer marketing consent    | —                                                    | **none for email.** `Order.smsOptIn` is SMS-only and per order. `Customer` has no consent column.                                                                                                                                             |
| Sender resolution             | `services/email-sender.ts#resolveSender`             | verified store domain → `<local>@<domain>`, else platform `noreply@ebda.app`. `ResendService.sendBrandedEmail` uses it.                                                                                                                       |
| Branded shell                 | `email.service.ts#renderBrandedShell`                | wraps content with the store header/footer.                                                                                                                                                                                                   |
| Sanitizer                     | `lib/email-html-sanitizer.ts#sanitizeNewsletterHtml` | allowlist pass, no dependency. Reused, not replaced.                                                                                                                                                                                          |
| Resend SDK 4.8.0              | `resend`                                             | supports `headers` (List-Unsubscribe) and `idempotencyKey` per send.                                                                                                                                                                          |
| Signed link precedent         | `lib/review-token.ts`                                | HMAC-SHA256, `REVIEW_TOKEN_SECRET → JWT_SECRET`.                                                                                                                                                                                              |
| Bulk throttle precedent       | `bulk-ai-*.ts`                                       | sleep-after-success at `AI_BULK_THROTTLE_MS`, batches of N per `step.run`.                                                                                                                                                                    |
| Existing broadcast            | `POST /stores/:id/newsletter/broadcast`              | sends inline with **up to 50 subscribers in one `to:` header** — every recipient sees the others' addresses. No unsubscribe link. See Ruling EC-6.                                                                                            |

## Design

### Data model (migration `20260925120000_email_campaigns` + hand-written `rollback.sql`)

- `CampaignStatus` enum: `draft | scheduled | sending | sent | cancelled | failed`.
- `CampaignRecipientStatus` enum: `queued | sent | failed | bounced | unsubscribed`.
- `campaigns`: `store_id`, `name`, `subject`/`subject_ar`, `body_html`/`body_html_ar` (sanitized on
  write AND again at send), `locale_strategy` (`subscriber | en | ar`), `audience` JSON
  (`{"source":"newsletter"}`), `status`, `scheduled_at`, `sent_at`, `recipient_count`,
  `sent_count`, `failed_count`, `last_error`, timestamps. Index `(store_id, created_at)`.
- `campaign_recipients`: `campaign_id`, `store_id`, `email` (lowercased), `subscriber_id?`,
  `customer_id?`, `locale`, `status`, `provider_message_id`, `error`, `sent_at`,
  `unsubscribed_at`, timestamps. **UNIQUE `(campaign_id, email)`**. Indexes
  `(campaign_id, status)`, `(store_id, status, sent_at)` (the 24h cap count), FK-only indexes on
  `subscriber_id` and `customer_id`.
- FKs: store → CASCADE (both), campaign → CASCADE, subscriber/customer → SET NULL (deleting a
  subscriber or customer must never delete send history nor be blocked by it).
- RLS: ENABLE + FORCE, four the earlier app role path policies copying
  `20260911190000_merchant_api_keys` byte for byte.
- The migration creates two empty tables, inserts nothing and schedules nothing. Its one data change is `UPDATE store_features SET enabled = false WHERE feature_key = 'email_campaigns'` — stale enabled rows (demo-boutique) from when the flag was hidden are reset to off (Ruling EC-10).

### Audience (consent)

Only **active newsletter subscribers of this store** (`isActive = true AND unsubscribedAt IS
NULL`), deduped by `lower(trim(email))`. Customers are not an audience source because no
email-marketing consent flag exists for them (Ruling EC-1). The recipient's `customer_id` is
linked when a customer of the same store has that email, for display only.

### Sending

1. `POST /campaigns/:id/send` (`{ scheduledAt? }`): draft only, audience > 0, audience ≤ the
   remaining 24h cap. Flips `draft → scheduled` and sends `campaign/send-requested` inside a
   try/catch. If the enqueue throws, the handler answers 503, so the request transaction rolls
   back and the campaign stays `draft` — nothing is left `scheduled` with no job behind it
   (Ruling EC-3).
2. Inngest `campaign-send` (concurrency 1 per store — keyed on `event.data.storeId` since #1955 — retries 4):
   - `load` — `draft` means the request has not committed yet → throw (retried). Anything other
     than `scheduled`/`sending` → stop.
   - `step.sleepUntil(scheduledAt)` when scheduled in the future, then re-check (a cancel wins).
   - `claim` — `updateMany where status = scheduled → sending`.
   - `materialize` — build the audience, re-check the cap (over cap → campaign `failed`,
     `DAILY_CAP_EXCEEDED`, zero recipients), `createMany … skipDuplicates` on the unique key.
   - `batch-i` (20 recipients each) — stop if the campaign was cancelled; per recipient
     re-read, skip unless `queued`, send ONE email to ONE address with
     `idempotencyKey = campaign-recipient/<id>`, mark `sent` + provider id, or `failed` + error;
     wait for a platform-wide send slot before each send (`CAMPAIGN_PLATFORM_SEND_INTERVAL_MS`,
     default 1000 → ≤1/s across all stores, #1955), and sleep `CAMPAIGN_SEND_THROTTLE_MS`
     (default 1000) after each success. A step stops inside
     `CAMPAIGN_BATCH_WALL_BUDGET_MS` (default 60s — each step is one request behind
     Cloudflare's 100s edge timeout) and never waits on the pacer past it (issue 2115).
   - `leftover-list-N` / `leftover-N-batch-j` — only when a batch deferred: re-list the
     still-`queued` recipients and send them in further budgeted steps.
   - `finalize` — counts; `sent`, or `failed` when nothing was delivered.
   - `onFailure` — campaign `failed` (only from scheduled/sending) and every still-`queued`
     recipient → `failed`, so no orphaned `queued` row survives a dead job.
3. Cap: `CAMPAIGN_DAILY_SEND_CAP` (default 1000) recipients per store per rolling 24h, counted
   from `campaign_recipients.status = sent`. Test sends do not count.
4. Sender: `ResendService` path → `resolveSender` (verified domain, else platform fallback), the
   same as transactional email.

### Unsubscribe

- Token `<storeId>.<recipientId>.<base64url HMAC-SHA256>` over a domain-separated string, secret
  `CAMPAIGN_UNSUBSCRIBE_SECRET → JWT_SECRET`, constant-time compare, no expiry.
- Every email body ends with a bilingual unsubscribe link to the storefront
  `/unsubscribe?token=…` page, and carries `List-Unsubscribe: <https://api…/public/campaigns/
unsubscribe?token=…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) when
  `API_URL` is https. Header values are built by us only; nothing user-controlled reaches a header.
- `GET /public/campaigns/unsubscribe` validates only (link scanners prefetch GETs).
  `POST` performs it: subscriber `isActive=false, unsubscribedAt=now`, recipient
  `status=unsubscribed, unsubscribedAt=now`. Idempotent.
- Storefront page `/unsubscribe` (bilingual via `LanguageContext`) shows the store and a confirm
  button.

### Admin UI (Marketing hub → "Campaigns")

- `/stores/[id]/campaigns` — list with status and counts, "New campaign".
- `/stores/[id]/campaigns/[campaignId]` — editor while `draft` (name, subject + body EN/AR, locale
  strategy, sanitized preview, audience count, AI draft, send test to me, send now / schedule with
  an in-page confirm step); read-only detail with per-recipient status table and cancel afterwards.
- Page-gated with `useRequireFeature('email_campaigns')`; hub tab + palette keywords.

### Security

Zod on every body/query/param, `authenticate → authorize('store_admin','super_admin') →
requireStoreAccess → requireFeature('email_campaigns')` on every admin route, sanitizer on write
and send, structured pino logs carrying ids only (never an email), GDPR erasure extended to
`newsletter_subscribers` + `campaign_recipients` for the erased email in that store.

## Tasks

1. Plan (this file) — commit.
2. Shared: un-hide `email_campaigns`, add campaign Zod schemas.
3. Database: schema + migration + rollback + enum re-exports.
4. API: `campaign-unsubscribe-token.ts`, `campaign.service.ts` (audience, cap, content, render),
   `campaign.routes.ts` (admin), `campaign-public.routes.ts`, `campaign-send.ts` Inngest function,
   AI draft, erasure extension, env docs.
5. Admin: pages, hub tab, palette keywords, en/ar messages.
6. Web: `/unsubscribe` page + translations.
7. Tests + mutation proof.
8. Docs: ENVIRONMENT.md, privacy data-map, RULINGS.md.

## Rulings

Recorded in `docs/RULINGS.md` under 2026-09-25 (EC-1 … EC-10).

## Verification

Unit tests: `tests/unit/campaign-audience.test.ts`, `campaign-send-job.test.ts`,
`campaign-routes.test.ts`, `campaign-unsubscribe-token.test.ts`,
`campaign-feature-default-off.test.ts`, `resend-marketing-send.test.ts`, plus the erasure cases in
`auth-erase-propagation.test.ts`. The job and audience tests run against
`tests/helpers/campaign-fake-db.ts`, which evaluates `where` clauses, so removing a predicate
changes the rows returned.

Mutation proof (2026-09-25; each mutant applied, the named test went red, the file restored
byte-identical — `cmp` + clean `git status`):

| Mutant                                                      | Red test                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| audience `where` without `isActive: true`                   | `includes only ACTIVE subscribers of this store`                                   |
| audience `where` without `unsubscribedAt: null`             | `excludes a row that is flagged active but carries an unsubscribedAt` (+1)         |
| audience `where` without `storeId`                          | `is tenant-scoped: another store's subscribers never appear`                       |
| batch guard `!r \|\| r.status !== 'queued'` → `!r`          | `a retried batch never re-sends a recipient that was already delivered`            |
| send-time consent re-check removed                          | `skips a subscriber who unsubscribed after the campaign was queued`                |
| `requireFeature('email_campaigns')` removed from the router | all 11 `feature OFF … → 403` cases + `a send attempt … enqueues and mails nothing` |
| token `timingSafeEqual` check removed                       | 4 tamper/forgery cases                                                             |

Migration: applied on a throwaway Postgres 16 with every prior migration (`prisma migrate
deploy`), RLS enabled + forced on both tables with 8 policies, both tables empty; `rollback.sql`
dropped both tables and enums; re-applying succeeded.

Not verified: a real send through Resend (no key in this environment), including whether Resend
accepts the `List-Unsubscribe` headers as given and how Gmail renders its unsubscribe
affordance; the Inngest function on a real Inngest server (the step shim replays memoized steps
the way Inngest documents, but it is a shim).

Stale override (Ruling EC-10): a read-only production check found demo-boutique with
`email_campaigns` enabled = true, left over from when the flag was hidden. The migration resets
every such row to false; verified on a throwaway Postgres 16 with a seeded demo-boutique-shaped row
(true → false, other features and other stores untouched), then rollback left it false.
