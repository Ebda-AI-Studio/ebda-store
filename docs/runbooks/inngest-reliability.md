# Inngest Reliability Runbook

> Operational patterns and operational gotchas for the 30+ Inngest functions in FWB.
> Audience: Ahmad (operator) and any Force AI engineer responsible for running or debugging async jobs.

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

The `queue-depth-watch` Inngest cron function (runs every 15 minutes) includes
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
`apps/api/src/services/alerts.service.ts` and DEPLOYMENT.md §4 for bot config.

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
`GET https://store-api.forcemediakw.com/health` returning 502/503 during deploy.

---

## Queue depth monitoring

The `queue-depth-watch` cron fires every 15 minutes and writes a summary to
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

## Related

- **Stuck job alert**: Telegram `@ForceAI1_bot` P1 level — see DEPLOYMENT.md §4
- **Inngest dashboard**: https://app.inngest.com — function execution history + retry audit
- **Auto-reaper source**: `apps/api/src/lib/inngest/functions/queue-depth-watch.ts`
- **mark-running-first source**: `apps/api/src/lib/inngest/functions/bulk-ai-recommendations.ts`
