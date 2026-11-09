# Cloudflare CI/CD — auto-deploy the Next apps as Workers

`.github/workflows/cf-deploy.yml` builds the three Next apps with OpenNext and
deploys them to Cloudflare Workers on every push to `main`. A per-app path filter
(`detect` job, native `git diff`) means a change to one app only rebuilds that
app; a change to `packages/**` or the CF tooling rebuilds all three; a manual
`workflow_dispatch` deploys all three.

**Diff base = the last SUCCESSFUL `cf-deploy` run on `main`, not `HEAD~1`
(2026-09-30).** The workflow's concurrency group cancels a superseded run, so two
back-to-back merges used to strand the first merge's app changes: its run was
cancelled and the next run diffed only its own commit (#2218's admin changes were
lost that way). `detect` now asks the Actions REST API
(`GET /repos/{repo}/actions/workflows/cf-deploy.yml/runs?branch=main&status=success&per_page=1`,
with `curl` — not the `gh` CLI, which nothing guaranteed was on the self-hosted
runner and whose absence silently deployed all three on every push, issue 2240)
for the base, so every commit since the last green deploy is covered however many
runs were cancelled or failed in between. The resolved base, or the reason it fell
back to deploying all three, is written to the run's step summary.
One sha is enough: a run is `success` only if every deploy job it did not skip
succeeded, and a job is skipped only when its app did not change — so after a
green run every app is current as of that sha. **Fail safe = deploy:** a lookup
error, no prior success, an unreachable sha or a non-ancestor base deploys all
three, and so does re-running the run that is already the last success. The one
deliberate no-op: re-running an OLDER run whose commit is already contained in the
last success deploys nothing (it would roll production back) — to redeploy `main`
use `workflow_dispatch`; to roll back use `wrangler rollback` or
`scripts/rollback.sh`. **Run history cannot see an out-of-band `wrangler rollback`
/ `wrangler versions deploy`** (issue 2241): the rolled-back worker stays on its old
version until a later commit touches its paths, with every run green. After such a
rollback, once `main` is fixed, redeploy with `gh workflow run cf-deploy.yml`
(dispatch deploys all three) — never rely on the next push.

**The storefront's cache mode must be explicit (issue 2240).** `OPENNEXT_CACHE`
must be exactly `true` or `false`; `scripts/assert-cf-cache-bindings.sh` fails the
web deploy (and CI's `cf-build-check`) on an unset or mistyped value, which used to
deploy the empty-cache config — a no-op `revalidateTag` — behind a green tick.
The same script also fails when the generated web config has no `version_metadata`
binding named `CF_VERSION_METADATA` (Ruling EDGE-BUILD-1): the storefront's two HTML
edge caches key on the Worker version id and switch off without it.

| App                        | Worker serves                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| **web** (`apps/web`)       | `store.ebda.app` + every merchant Custom Hostname (demo-merchant.com, …) via the SaaS `*/*` fallback |
| **admin** (`apps/admin`)   | `store.ebda.app` — Vercel `store.ebda.app` stays live until a deliberate DNS cutover                 |
| **orders** (`apps/orders`) | `orders.ebda.app` — Vercel `orders.ebda.app` stays live until cutover                                |

The `custom_domain` routes create the `admin.`/`orders.ebda.app` DNS records +
edge certs automatically on first deploy (needs the token's Zone DNS+SSL perms).

It runs on **GitHub-hosted runners (`ubuntu-latest`)** under the current policy
(`vars.USE_SELF_HOSTED == 'false'`, the same variable `ci.yml`/`deploy.yml` use;
[Ruling CI-CRON-1](../rulings/CI-CRON-1.md)),
so it **bills cloud Actions minutes** like every other push/PR job; it is not
zero-cost (the CI-CRON-1 estimate covers the crons only, see Ruling CI-CRON-2). If
the variable is set back to `true` it runs on the self-hosted WSL2 runner instead,
and a dispatch with `force_cloud: true` forces `ubuntu-latest` for one run.

## One-time setup

### 1. Create a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.

| Permission                             | Scope                  |
| -------------------------------------- | ---------------------- |
| Account › **Workers Scripts** › Edit   | Ebda AI Studio account |
| Account › **Account Settings** › Read  | Ebda AI Studio account |
| Zone › **Workers Routes** › Edit       | `ebda.app`             |
| Zone › **DNS** › Edit                  | `ebda.app`             |
| Zone › **SSL and Certificates** › Edit | `ebda.app`             |

(The DNS + SSL zone perms are required because the worker's `custom_domain`
routes create/manage the hostname + its edge cert.)

> This is a **separate** token from `CF_API_TOKEN` (the API's Cloudflare-for-SaaS
> Custom-Hostnames token, which only needs SSL+Zone:Read). Don't reuse that one —
> it can't deploy Workers.

### 2. Add the GitHub repo **secrets**

Settings → Secrets and variables → Actions → **Secrets**:

| Secret                  | Value                              |
| ----------------------- | ---------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | the token from step 1              |
| `CLOUDFLARE_ACCOUNT_ID` | `9f70414f9a626137f1004fa2f4add904` |

(`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` are already set for `ci.yml` —
the deploy's `notify-failure` job reuses them.)

### 3. Add the GitHub repo **variables**

Settings → Secrets and variables → Actions → **Variables**. These are the
**public** `NEXT_PUBLIC_*` build values — they ship in the browser bundle, so
they are NOT secrets; repo variables keep them versioned + drift-free. Any unset
variable falls back to the documented prod default in the workflow.

Pull the exact production values from Vercel (single source of truth) — these
are public but are deliberately NOT hardcoded here so they can't drift and don't
add key-shaped strings to git history:

```bash
cd <repo> && npx vercel@latest env pull /tmp/web.env --environment production --yes
grep '^NEXT_PUBLIC_' /tmp/web.env   # copy each into a GitHub repo Variable
rm /tmp/web.env
```

| Variable                       | Where it comes from                                          |
| ------------------------------ | ------------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`          | `https://api.ebda.app/api/v1` (workflow default)             |
| `NEXT_PUBLIC_APP_NAME`         | `Force Store` (workflow default)                             |
| `NEXT_PUBLIC_SITE_URL`         | `https://store.ebda.app` (workflow default)                  |
| `NEXT_PUBLIC_ONESIGNAL_APP_ID` | _leave empty — storefront OneSignal not configured_          |
| `NEXT_PUBLIC_POSTHOG_HOST`     | `https://us.i.posthog.com` (workflow default)                |
| `NEXT_PUBLIC_POSTHOG_KEY`      | Vercel `force-web` prod (`phc_…`)                            |
| `NEXT_PUBLIC_SENTRY_DSN_WEB`   | Vercel `force-web` prod (`https://…@…ingest.us.sentry.io/…`) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Vercel `force-web` prod (base64 `B…`)                        |

> The four values marked "workflow default" are baked into `cf-deploy.yml` as
> fallbacks, so you only strictly NEED to set the three from Vercel
> (`POSTHOG_KEY`, `SENTRY_DSN_WEB`, `VAPID_PUBLIC_KEY`) plus leave ONESIGNAL
> empty. Setting all eight is fine and makes the source of truth explicit.

That's it. The next push to `main` touching `apps/web/**` deploys automatically.

## What the workflow does

1. `npm ci`
2. Builds the workspace packages the storefront needs (`@ebda/database` → `@ebda/shared` → `@ebda/ui`)
3. `scripts/cf-setup-local.sh web` — installs the local-only OpenNext/wrangler devDeps and writes `apps/web/{open-next.config.ts,wrangler.jsonc}` **with the ebda.app routes** (store + cf fallback + `*/*` SaaS catch-all)
4. Writes `apps/web/.env.production.local` from the repo variables (NEXT*PUBLIC*\* are build-time inlined)
5. `scripts/cf-build.sh web` — the OpenNext build (moves `instrumentation.ts` aside for the trace workaround, then restores it)
6. `cd apps/web && npx wrangler deploy`

On failure (push to main only) the `notify-failure` job fires a Telegram alert.

## Manual deploy (fallback)

```bash
bash scripts/cf-setup-local.sh web
# write apps/web/.env.production.local with the NEXT_PUBLIC_* values above
bash scripts/cf-build.sh web
cd apps/web && npx wrangler deploy
```

### Extra repo variables for admin / orders

The admin + orders jobs hardcode their non-secret values in the workflow (each app
needs DIFFERENT values — e.g. admin `NEXT_PUBLIC_API_URL` has **no** `/api/v1`
suffix, and `APP_NAME` is "Force Admin"), and read only the key-shaped values from
repo variables:

| Variable                              | App    | Where it comes from        |
| ------------------------------------- | ------ | -------------------------- |
| `NEXT_PUBLIC_SENTRY_DSN_ADMIN`        | admin  | Vercel `force-admin` prod  |
| `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` | orders | Vercel `force-orders` prod |
| `NEXT_PUBLIC_POSTHOG_KEY`             | admin  | shared (already set)       |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`        | orders | shared (already set)       |

## Cutover (later, deliberate)

This workflow deploys admin/orders to the **new** `admin.`/`orders.ebda.app`
subdomains. The live Vercel domains (`store.ebda.app`,
`orders.ebda.app`) are **untouched** — verify the ebda.app subdomains
work, then cut their DNS / rebrand when ready (and drop the Vercel projects after
a soak), exactly as demo-merchant was cut over for the storefront.

## Runner requirements

Every job in `cf-deploy.yml` (including `detect` and `notify-failure`) picks its
runner from `vars.USE_SELF_HOSTED`, and the workflow has no `schedule:` trigger, so
it does not read `SCHEDULED_ON_CLOUD`. Per
[Ruling CI-CRON-1](../rulings/CI-CRON-1.md)
the repo runs push, PR and dispatch on cloud (`USE_SELF_HOSTED=false`); only
`schedule:` runs in other workflows are pinned to the self-hosted runner. Runner
outage handling for those crons is not covered by an in-repo runbook.

**Consequence:** a deploy no longer waits for the self-hosted runner (the Mac being
awake), but it does use GitHub-hosted minutes (not zero-cost; see Ruling CI-CRON-2).
Cloud billing blocked again is the one case where deploys stop running.

- **`force_cloud` workflow_dispatch input:** each job's `runs-on` honours a
  `force_cloud: true` manual-dispatch flag that switches that run to
  `ubuntu-latest`. It is a live escape hatch again: with `USE_SELF_HOSTED=false`
  it changes nothing, and if the variable is ever set to `true` it is how a single
  deploy is sent to cloud without changing the variable.
- **Manual deploy when needed:** Actions → "Deploy to Cloudflare" → "Run
  workflow" (deploys all three), or push to `main`. If cloud billing is blocked
  and you need a deploy now, use the local fallback in "Manual deploy (fallback)"
  above.
- **`vars.USE_SELF_HOSTED` should stay `false`** (push/PR/dispatch on cloud). Do
  not set it to `true` while troubleshooting a deploy: it moves every push/PR job
  in the repo, including the full CI matrix, back onto the two-runner Umbra pool,
  which undoes Ruling CI-CRON-1.

## Follow-ups

- **Server-side Sentry on the CF target — web DONE (2026-07-02), admin/orders still open.**
  `apps/web/sentry-worker-entry.ts` wraps the OpenNext Worker's fetch handler with
  `@sentry/cloudflare`'s `Sentry.withSentry(...)`, `apps/web/wrangler.jsonc` `main`
  points at it, and `compatibility_date` was bumped to `2025-08-16` (Sentry's
  Cloudflare SDK requires it for `https.request`). The `deploy-web` job passes the
  DSN as a runtime var: `wrangler deploy --var SENTRY_DSN:<value>`, sourced from
  the same `NEXT_PUBLIC_SENTRY_DSN_WEB` repo variable used for client Sentry —
  omitted entirely when unset, so unconfigured/preview deploys still build. Client-side
  Sentry works via each app's `instrumentation-client.ts` regardless. **`apps/admin`**
  (has `instrumentation.ts` + `NEXT_PUBLIC_SENTRY_DSN_ADMIN` already) and **`apps/orders`**
  (no Sentry wiring at all yet) still need the same worker-entry treatment — repeat the
  `apps/web` pattern for each: custom worker entry + `main` override + compat-date bump
  - `--var` in their `cf-deploy.yml` deploy jobs.
