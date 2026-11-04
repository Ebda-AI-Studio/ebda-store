> **Historical (Ruling G5-3).** Inngest was removed on 2026-10-25; jobs run on Cloudflare Workflows and Queues. For incidents use `docs/INCIDENT.md` section 3 and `docs/cf/jobs-map.md`. The rest of this page describes the retired Inngest setup.

# Inngest Reliability Runbook

> Operational patterns and operational gotchas for the 30+ Inngest functions in Ebda Store.
> Audience: Ahmad (operator) and any Ebda AI Studio engineer responsible for running or debugging async jobs.

---

## Key patterns (codified from live incidents)

### 1. mark-running-first (commit `46269715`)

Every Inngest function that **mutates a job row** (bulk-ai-recommendations,
bulk-translate, bulk-seo, etc.) MUST flip `status = 'running'` as the **first
`step.run()`** — before loading products, before calling Gemini, before anything.

**Why it matters:**

If a function is delivered by Inngest but crashes/times out before writing any
status, the job row stays at `status = 'queued'`. From the operator's
perspective "queued" is ambiguous between:

- **Never delivered**: Inngest hasn't called our endpoint yet
- **Delivered but hung**: the function started, crashed, and left no trace

`mark-running-first` collapses this to one observable state:

- `queued` = Inngest queue, not yet delivered
- `running` = delivered + in progress (or crashed after the first step)
- `failed` / `completed` = terminal

**Pattern to use for any new job function:**

```typescript
export const myBulkJob = inngest.createFunction(
  { id: 'my-bulk-job', retries: 2 },
  { event: 'store/my-bulk-job.requested' },
  async ({ event, step }) => {
    // ALWAYS first
    await step.run('mark-running', async () => {
      await prisma.bulkAiJob.update({
        where: { id: event.data.jobId },
        data: { status: 'running', startedAt: new Date() },
      });
    });

    // ... rest of the job
  }
);
```

---

### 2. Stuck-running auto-reaper (commit `8c229e2b`)

The `queue-depth-watch` Inngest cron function (runs hourly, Ruling INNGEST-BUDGET-1) includes
an auto-reaper step that writes `status = 'failed'` on any job that has been in
`status = 'running'` for **more than 60 minutes**.

**What the reaper does:**

```typescript
await step.run('reap-stuck-running', async () => {
  const stuck = await prisma.bulkAiJob.findMany({
    where: {
      status: 'running',
      startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  for (const job of stuck) {
    await prisma.bulkAiJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage: 'auto-reaped: exceeded 60min running limit' },
    });
  }
  if (stuck.length > 0) {
    await alertsService.send({
      level: 'p1',
      scope: 'platform',
      source: 'queue-depth-watch',
      title: `auto-reaped ${stuck.length} stuck-running jobs`,
      body: stuck.map(j => `${j.kind} job ${j.id} stuck since ${j.startedAt}`).join('\n'),
    });
  }
});
```

**Alert routing:** a Telegram P1 fires on any auto-reap event. See
`apps/api/src/services/alerts.service.ts` and docs/DEPLOYMENT.md §4 for bot config.

**When you see the alert:**

1. Check the reaped job(s) in Admin → Bulk Operations or query `bulkAiJob` table
2. Confirm whether it was a Gemini timeout (most common) or a Railway deploy mid-job
3. Jobs are safe to re-queue manually — the job idempotency key prevents double-apply

---

### 3. Deploy-cascade kills in-flight Inngest invocations

**Problem:** every Railway redeploy causes ~1–2 minutes of service unavailability.
During this window, Inngest may deliver function events to the dying process and
never receive a response. Inngest marks those as failed and retries (per the
function's `retries` count).

If you push 3–5 commits within 60 seconds (each triggering a Railway deploy),
the cascading restarts can kill multiple in-flight bulk jobs, exhaust their
retry budgets, and leave job rows stuck in `failed` state.

**Mitigation:**

- Batch multiple API commits into one push (`git commit --amend` or bundle fixes)
- Space pushes by at least 3–4 minutes when bulk jobs are actively running
- Before a push: check Admin → Bulk Operations for any jobs at `status=running`
- If a deploy-cascade kill does happen: re-queue the failed jobs manually — they
  idempotently resume from the next product in the batch

**Railway deploy indicator:**
`GET https://api.ebda.app/health` returning 502/503 during deploy.

---

## Queue depth monitoring

> Jobs run on Cloudflare Workflows + Queues (Inngest was removed in #294). A job row still `queued` after 30 min is
> re-dispatched once by `queue-depth-watch`; if it is still queued at a later tick it is marked failed
> (`error_message = 'never started'`) and ONE P1 alert (source `jobs.queue-depth`) names the job id. Check the
> JOBS_WORKFLOW / JOBS_QUEUE bindings and the Worker logs; there is no `/api/v1/inngest` to re-PUT. Enqueue failures
> mark the row failed immediately; a dispatch that would start nothing throws in the Worker (Ruling JOBS-ORPHAN-1).

The `queue-depth-watch` cron fires hourly (Ruling INNGEST-BUDGET-1) and writes a summary to
Telegram at the `info` level when the queue depth exceeds a threshold:

```sql
-- Manual queue depth check
SELECT kind, status, count(*)
FROM bulk_ai_jobs
WHERE created_at > now() - interval '24 hours'
GROUP BY kind, status
ORDER BY kind, status;
```

Healthy state: no rows with `status = 'running'` older than 30 minutes.

---

---

### 4. Per-product transient retry for Gemini 503/429 (2026-05-23)

Gemini free-tier spikes occasionally return HTTP 503 "Service Unavailable" or
rate-limit 429 mid-sweep. Without retry, a single overload burst permanently
marks affected products as failed for that run.

**Fix:** `callWithRetry<T>(fn, label, maxAttempts=3)` wrapper in every bulk-AI
function. Placed per entity, NOT per sweep — completed products are never re-run.

**Backoff:** 2s → 4s → 8s + up to 500ms jitter, capped at 15s.
Gemini demand spikes typically resolve in under 30s, so 3 attempts cover the
common case while adding at most ~14s of latency per affected product.

**What is retried (transient):**

- HTTP 503 (model high demand)
- HTTP 429 where `.code` is NOT a quota-cap error (rate-limit only)
- Network errors: `timeout`, `ECONNRESET`, `ETIMEDOUT`

**What is NOT retried:**

- Quota-cap errors (`AI_QUOTA_DAILY_EXCEEDED` / `AI_QUOTA_MONTHLY_EXCEEDED`)
- Auth errors (401/403)
- Bad-input errors (400)
- The `ERROR_CAP = 50` whole-sweep bail still applies after all retries exhaust

**Pattern to use in any new bulk-AI function:**

```typescript
// Add this helper near the top of the file (alongside sleep / THROTTLE_MS)
async function callWithRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const msg = (err instanceof Error ? err.message : String(err)) ?? '';
      const transient =
        status === 503 ||
        (status === 429 && !isAiQuotaCapError(err)) ||
        /timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!transient || attempt === maxAttempts) throw err;
      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 15000) + Math.floor(Math.random() * 500);
      logger.warn(
        { label, attempt, maxAttempts, status, err: msg },
        '[bulk-ai] transient gemini failure, retrying'
      );
      await sleep(delayMs);
    }
  }
  throw new Error('callWithRetry: exhausted attempts');
}

// Then wrap each per-entity Gemini call:
const result = await callWithRetry(() => model.generateContent(prompt), `sweep-name:entity-id`);
```

**Railway log on retry:** `[bulk-ai] transient gemini failure, retrying` at WARN
level with `{ label, attempt, maxAttempts, status, err }`.

**Quota note:** each retry counts against `assertAiQuota()`. The quota check runs
before the call. If quota is exhausted mid-retry, `isAiQuotaCapError` re-throws
and bypasses the retry loop — no double-counting.

**Files with this pattern as of 2026-05-23:**

- `bulk-ai-recommendations.ts` — wraps `model.generateContent(prompt)`
- `bulk-ai-seo.ts` — wraps 3× `AIService.suggestSeo()`
- `bulk-ai-translate.ts` — wraps 6× `AIService.translate()`
- `bulk-ai-aeo.ts` — wraps 4× `model.generateContent()` (FAQ, HowTo, meta-store, meta-product)

---

### 5. Global mutation limiter exempts signed step callbacks (2026-09-25)

**Problem:** the API's global limiter (`apps/api/src/index.ts`) caps 200
mutations (POST/PUT/PATCH/DELETE) per IP per 15 minutes. Inngest Cloud
executes every function **step** as its own POST to `/api/v1/inngest`, from a
small, fixed pool of Inngest IPs — an order fanout is ~12 steps, and a cron
sweep runs several functions back to back. A busy period can push one Inngest
IP past 200/15min and get 429'd, which Inngest treats as a failed delivery
and retries — delaying order emails, refunds and stock restore. A local
harness reproduced this exactly.

**Fix:** `skipGlobalRateLimit` (`apps/api/src/middleware/
global-rate-limit-skip.ts`) skips the global limiter for `POST
/api/v1/inngest` **only when the request carries `x-inngest-signature`**. It
does not verify the header itself — `inngestServe` does that cryptographically
against `INNGEST_SIGNING_KEY` and rejects (401) before running any function
code, so an attacker without the key gains nothing but a rejected request.
See `docs/RULINGS.md` Ruling RL-1 for the full citation into the installed
`inngest` SDK source, and Ruling RL-2 for why the payment-webhook routes
(`/api/v1/webhooks/payment/*`) were deliberately NOT given the same
exemption — they persist + enqueue the inbound event before their signature
is actually verified, so skipping the counter there would let an
unauthenticated flood cost real DB/queue work before rejection.

**Hardened 2026-10-01 (issue 2063, issue 2064):** the exemption now also
requires `NODE_ENV=production` AND a non-empty `INNGEST_SIGNING_KEY`
(`inngestSignatureIsEnforced`) — the only state in which the SDK verifies
signatures (it is in dev mode, verifying nothing, whenever `NODE_ENV` is not
`production`). Boot logs an error and pages P1 if the key is missing in
production. Header presence is not a secret, so the path has its own bucket,
`inngestLimiter` (`middleware/security.ts`), mounted before the body parser:
300 per 15 minutes per IP, counting ONLY caller-fault answers — a 4xx other
than 429 (`inngestRequestWasSuccessful`) — so forged (401) and malformed
(400/405/413) calls are capped while signed step callbacks never spend it. A
5xx from a genuinely failing step and the limiter's own 429 are NOT counted
(issue 2314): Inngest delivers every function from a small shared IP pool,
so counting them let an incident's retries lock out healthy callbacks —
including the stuck sweeps that recover from it — for the whole window. `tests/unit/inngest-serve-rejects-unsigned.test.ts` drives the
REAL `inngest/express` handler in cloud mode and asserts a forged or missing
signature is a 401 with no function run, so an SDK upgrade cannot quietly
change the assumption.

If Inngest step callbacks start 429ing again, check first whether the
signature header changed name/casing on Inngest's side (it would silently
stop matching and fall back to the counted path) before assuming the cap
itself needs raising.

---

## Related

- **Stuck job alert**: Telegram `@ebda1_bot` P1 level — see docs/DEPLOYMENT.md §4
- **Inngest dashboard**: https://app.inngest.com — function execution history + retry audit
- **Auto-reaper source**: `apps/api/src/lib/inngest/functions/queue-depth-watch.ts`
- **mark-running-first source**: `apps/api/src/lib/inngest/functions/bulk-ai-recommendations.ts`
- **Transient retry memory**: `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-ebda-store/memory/feedback-ebda-bulk-ai-transient-retry-per-product.md`
