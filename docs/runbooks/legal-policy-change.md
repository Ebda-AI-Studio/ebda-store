# How to publish a legal policy change

Rulings LEGAL-4, LEGAL-5, LEGAL-6. The policy TEXT lives in `apps/marketing/src/lib/legal-ar.ts`
(primary) and `legal-en.ts`; the VERSION of each document lives in `LEGAL_POLICIES`
(`packages/shared/src/legal/index.ts`). Both change in the same PR.

## 1. Edit and version (one PR)

1. Edit the text in `legal-ar.ts` and `legal-en.ts`.
2. Append one entry to that document's `history` in `LEGAL_POLICIES`:
   - `version`: next number (`1.0` -> `1.1`; `2.0` for a rewrite).
   - `publishedAt`: the merge/deploy date (YYYY-MM-DD). It becomes "Last updated" on the page.
   - `effectiveAt`: when it binds. For a **fee change** at least 30 days after `publishedAt`
     (the unit test refuses less).
   - `material`: `true` if a merchant would reasonably want to know (fees, liability, data use,
     termination, new obligations). Typos and formatting are `false`.
   - `feeChange`: `true` only if fees change (implies `material: true`).
   - `summary.ar` / `summary.en`: one or two plain sentences on WHAT changed.
3. If the change adds a sub-processor, update the Privacy Policy first (Ruling LEGAL-3).
4. `npx vitest run packages/shared/src/__tests__/legal-policies.test.ts tests/unit/marketing-site.test.tsx`.

## 2. Merge and deploy

Merge. `cf-marketing-deploy.yml` republishes ebda.app. The API must also run the new registry:
`gh workflow run cf-api-deploy.yml` (API deploys are manual). Then check:

    curl -s https://ebda.app/terms/ | grep -o '<time[^<]*</time>'
    curl -s https://ebda.app/en/terms/ | grep -o '<time[^<]*</time>'
    curl -s https://api.ebda.app/health   # commit == main tip

## 3. Announce (material versions only)

Super admin -> **Policy updates** (`store.ebda.app/policy-updates`) -> the document shows the new
version with **Send notice** -> confirm. This emails every store owner once (owners of non-deleted,
non-demo stores, role store_admin; suspended/inactive owners included) and shows a banner in their
dashboard until they press "Got it". It cannot be sent twice (409). The email is bilingual, Arabic
first, for everyone (Ruling LEGAL-6), and carries no unsubscribe link by design.

## 4. Watch the run

The page shows per-version counts (queued / sending / sent / failed) and a list of failed
deliveries (masked email, reason, time). Refresh to follow it.

- `queued`: waiting for the job. While the job runs this drains.
- `sent` / `failed`: final.
- `sending` ("stuck"): the row was claimed and the job died or crashed around the send. **It never
  finishes or retries by itself** (at-most-once, Ruling LEGAL-5(a)). Check each one manually
  (Resend dashboard by recipient/time); contact the merchant directly if the mail did not go out.
- `queued` that does not drain after the run ended: the job stopped before reaching them (see
  LEGAL-5(f): the sender was demoted/deleted mid-run). A P1 alert fires. There is no automated
  re-send; a re-run needs an engineer.
- Banner is the second channel: every merchant with a SENT, material, current, unacknowledged
  version sees it regardless of email outcome.

### Failure reasons (`error` on a failed delivery)

| Reason                  | Meaning                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEND_WINDOW_EXHAUSTED` | The job hit its 900-step cap; the rest were marked failed and a P1 (`legal.notice.window_exhausted`) was raised.                                                                                                                               |
| `SEND_JOB_FAILED`       | The Inngest job died after retries; `onFailure` marked the unsent rows failed.                                                                                                                                                                 |
| `RESEND_NOT_CONFIGURED` | Production without a Resend key: the send throws instead of marking mail `sent`. Fix the env, then handle the failed rows.                                                                                                                     |
| `USER_GONE`             | The recipient's account no longer exists when its turn came.                                                                                                                                                                                   |
| `SEND_ROW_MISSING`      | The send row was withdrawn/missing when the fan-out materialised recipients; nobody was mailed.                                                                                                                                                |
| `WITHDRAW_FAILED`       | (API 502, not a delivery row.) Enqueue failed AND the compensating withdraw refused (the run may have started): a P1 `legal.notice.withdraw_failed` fires and the page shows "send uncertain". Check the counts before pressing anything else. |

Provider error text on a failed row is scrubbed of email addresses and truncated.

### Pacing and limits

- The job shares the campaign pacer: `CAMPAIGN_PLATFORM_SEND_INTERVAL_MS` (default 1000 ms, all
  stores' campaigns and legal notices combined). A busy platform slows the notice, never breaks
  Resend's shared 2 req/s.
- Each job step has a FIXED 60 s budget (constant, no env var), 20 recipients per step. A step
  that gets no pacer slot ends and the work continues in a later step.
- The step loop is capped at 900 steps: roughly 18,000 recipients is an UPPER bound, and fewer if
  steps defer. The cap leftover is failed with `SEND_WINDOW_EXHAUSTED`.
- Recipients are materialised in ONE transaction (30 s timeout), which also caps reach. Fine at
  today's scale; revisit before the merchant count is in the thousands.

## 5. Verify

- The page shows "N sent, 0 failed ... of N" once the run finishes.
- A test merchant sees the banner on any store page; "Got it" removes it everywhere.
- Read-only SQL on production:
  `SELECT status, count(*) FROM legal_notice_deliveries WHERE doc_key='terms' AND version='1.1' GROUP BY 1;`
- Failed rows are also listed on the Policy updates page; re-sending is not automated
  (Ruling LEGAL-5): handle individually.
