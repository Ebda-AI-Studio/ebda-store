# Incident Response — Ebda Store

Rewritten 2026-11-10 for the real stack (Iceberg audit #25): Cloudflare Workers, D1, Durable Objects, R2, Queues/Workflows.
Neon, Railway, Axiom and UptimeRobot are gone (Postgres retired 2026-11-05); nothing here should send you to them.
Companion docs: **who to call and when** → [`ops/escalation.md`](ops/escalation.md) · **how to roll back** →
[`ROLLBACK.md`](ROLLBACK.md) · **data recovery** → [`DB-BACKUP-RESTORE.md`](DB-BACKUP-RESTORE.md) · targets → [`observability/slo.md`](observability/slo.md).

## What runs where

| Worker                                       | Host                                        | Data                                                                                          |
| -------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ebda-api`                                   | `api.ebda.app`                              | D1 `ebda-platform`, one StoreDO per store, AuthState DO, KV, R2, Queues/Workflows `ebda-jobs` |
| `ebda-web`                                   | `*.ebda.app` storefronts + merchant domains | calls the API; ISR cache R2 `ebda-web-isr-cache`                                              |
| `ebda-admin`                                 | `store.ebda.app`                            | calls the API                                                                                 |
| `ebda-orders`                                | `orders.ebda.app`                           | calls the API                                                                                 |
| `ebda-accounts`                              | `accounts.ebda.app`                         | D1 `ebda-identity` (merchant sign-in, MFA, passkeys)                                          |
| `ebda-marketing` / `ebda-help` / `ebda-docs` | `ebda.app` / help / docs                    | static                                                                                        |
| `ebda-status`                                | `status.ebda.app`                           | probes every component every 5 minutes                                                        |

Ebda Chat / WhatsApp is a separate repo and Worker (`ebda-whatsapp`, `wa.ebda.app`) with its own per-alert runbooks.

## Severity matrix

| Severity | Definition                                                 | Examples                                                                                        | Response (see escalation.md) |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| **P0**   | Storefronts or checkout down, data at risk, payments wrong | `api.ebda.app/health` not 200, storefront probes red on status.ebda.app, D1 errors, a data leak | ack 15 min, work immediately |
| **P1**   | Major feature broken, workaround exists                    | merchants cannot sign in but stores sell; one provider's payments failing; jobs stuck > 2 h     | ack 1 h                      |
| **P2**   | Degraded, low impact                                       | slow images, delayed emails, one store's pixel wrong                                            | same day                     |
| **P3**   | Cosmetic                                                   | typo, Arabic wording                                                                            | backlog                      |

## Detection (where an incident shows up)

1. **status.ebda.app** (`apps/status`, Worker `ebda-status`): probes every component every 5 minutes (15 s hard timeout; was 1 min until 2026-11-14,
   8 s until 2026-11-15); an incident **opens after 2 consecutive failures** (detection 5-10 min), resolves after 1 good probe, and each
   open/resolve goes to **Telegram** (`apps/status/src/alert.ts`). **Slow is not down (STORE-EDGE-4):** a 200 with the right body
   that took 8 s < t <= 15 s shows the component as **Degraded** (amber, "slow: over 8 s", response time on the page and in
   `/api/status.json` `latencyMs` + `slow`) and pages nobody; a failure is non-200, body mismatch, timeout > 15 s, or **2 slow probes in a
   row** (that one opens the incident at once). Cadence stays 5 min (frugality ruling), never back to 1 min. Constants:
   `DEFAULT_TIMEOUT_MS`, `SLOW_THRESHOLD_MS`, `SLOW_STREAK_FAILS` in `apps/status/src/config.ts`. A lone Degraded storefront in quiet
   hours is a cold render, not an outage: check `x-store-edge` on the page (`MISS` = cold, `STALE`/`HIT` = edge).
   Probes: `apps/status/src/config.ts`.
2. **API alerts → Telegram** (`apps/api/src/services/alerts.service.ts`): P1 alerts from jobs, queues, payment webhooks,
   email/SMS dead letters, `alerts-failure-watch`.
3. **Sentry** (error tracker for api/web/admin/orders) → alert bridge → Telegram.
4. **GitHub Actions**: a red `cf-<app>-deploy.yml` means that Worker still serves the OLD build; `cf-api-deploy.yml`
   auto-rolls back when `/health` or the unknown-store probe fail after deploy. A red `cf-backup.yml` /
   `cf-backup-drill.yml` pages Telegram (no nightly backup).
5. **Merchant report** (WhatsApp / email, see escalation.md): treat as P1 until ruled out.

## P0 triage (in order; stop at the root cause)

**1. Is the API up, and is it the commit you think?**

```bash
curl -sS -m 10 https://api.ebda.app/health        # want status ok, platform_db ok
git ls-remote origin main                           # compare to /health "commit"
curl -sS -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' https://storedemo-souq.ebda.app/ar
```

**2. Which Worker, and what is it logging?** (wrangler OAuth login is enough for deployments + tail)

```bash
npx wrangler deployments list --name ebda-api      # or ebda-web / ebda-admin / ebda-orders / ebda-accounts …
npx wrangler tail ebda-api --format pretty --status error     # live stream
```

Older than the live window: Workers Logs in the dashboard (Workers & Pages → Worker → Logs; `ebda-api` and `ebda-web` keep a 10 % sample), then the 30-day Logpush
copy in R2 bucket **`ebda-logs`** (gzip NDJSON under `workers/<date>/`, read key in `~/.claude/.ebda-logpush-env`,
`docs/DEPLOYMENT.md` §7):

```bash
rclone lsf r2logs:ebda-logs/workers/ | tail -3
rclone cat r2logs:ebda-logs/workers/<date>/<file>.log.gz | gunzip | jq -c 'select(.Outcome != "ok") | {ScriptName, Outcome, Exceptions}'
```

**3. Is the data layer answering?** (read-only)

```bash
npx wrangler d1 execute ebda-platform --remote --command "SELECT count(*) FROM stores"
npx wrangler d1 execute ebda-identity --remote --command "SELECT count(*) FROM users"
```

A single store failing while others work points at that store's Durable Object: check its errors in the tail output.

**4. Are background jobs running?**

```bash
cd apps/api
npx wrangler workflows instances list ebda-jobs | head
npx wrangler queues list | grep ebda-jobs
```

`errored` / stuck instances → `wrangler workflows instances describe ebda-jobs <id>`; a message in `ebda-jobs-dlq`
exhausted its attempts and has already alerted; a `JobGate` lease frees itself after 20 min.

**5. Did anything deploy in the last hour?**

```bash
gh run list --workflow cf-api-deploy.yml -L 3 ; gh run list --workflow cf-web-deploy.yml -L 3
git log origin/main --since="1 hour ago" --oneline
```

**6. Payments specifically?** Day-1 methods are COD and InstaPay (manual confirmation); card gateways run on the
merchant's own Paymob/Kashier/Fawry account. Check the super-admin `/webhook-events` inbox (replayable), Sentry tag
`payment.provider`, and the provider's merchant portal; a rotated per-store secret breaks webhook signatures.

## Recovery

| Symptom                                  | Fix                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad deploy of one Worker                 | `cd apps/<app> && npx wrangler rollback` (or `npx wrangler versions deploy <id>@100`); after main is fixed, `gh workflow run cf-<app>-deploy.yml` (a rollback is invisible to the deploy workflow, `ROLLBACK.md`) |
| Bad code across apps                     | `bash scripts/rollback.sh` (revert + push); if the revert touches no API path, also `gh workflow run cf-api-deploy.yml`                                                                                           |
| Bad D1 migration / bad write in D1       | `npx wrangler d1 time-travel restore ebda-platform --timestamp <before>` (prints the bookmark to undo); identity: same on `ebda-identity`                                                                         |
| One store's data damaged                 | StoreDO point-in-time recovery, else restore that store from the nightly R2 dump (`DB-BACKUP-RESTORE.md`)                                                                                                         |
| Cloudflare account lost                  | the Mac off-account copy `~/Desktop/projects/_backups/ebda-cf-encrypted/` + the age key (`DB-BACKUP-RESTORE.md`)                                                                                                  |
| Jobs not firing                          | `wrangler workflows instances list ebda-jobs`; Cron Triggers in `apps/api/wrangler.jsonc`; `ebda-jobs` queue depth                                                                                                |
| Rate-limit false positives               | raise the limiter temporarily or add a path skip, deploy through `cf-api-deploy.yml`                                                                                                                              |
| Webhook signatures failing for one store | re-paste the webhook secret from the provider portal into that store's payment settings                                                                                                                           |

Every fix ends with the production check: `/health` commit = tip of main, the failing probe green on status.ebda.app.

## After the incident

1. Every P0/P1: a short postmortem in `docs/incidents/<date>-<slug>.md` (what happened, impact, root cause, fix,
   prevention: test, alert or guard).
2. A new failure class → memory + a deterministic gate (test, lint, probe), not a note.
3. Tell affected merchants what happened and what changed (escalation.md, merchant comms).

## Solo-operator reality

Ebda is run by one person today. The wake-up signals that exist are status.ebda.app → Telegram and the API/Sentry alert
bridge → Telegram. There is **no second operator yet**; what happens when Ahmad is unreachable is in
[`ops/escalation.md`](ops/escalation.md).
