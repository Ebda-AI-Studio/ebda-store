# Cloudflare CI/CD — auto-deploy the Next apps as Workers

`.github/workflows/cf-deploy.yml` builds the three Next apps with OpenNext and
deploys them to Cloudflare Workers on every push to `main`. A per-app path filter
(`detect` job, `dorny/paths-filter`) means a change to one app only rebuilds that
app; a change to `packages/**` or the CF tooling rebuilds all three; a manual
`workflow_dispatch` deploys all three.

| App                        | Worker serves                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| **web** (`apps/web`)       | `store.force-ai.co` + every merchant Custom Hostname (wadyaljuz.com, …) via the SaaS `*/*` fallback |
| **admin** (`apps/admin`)   | `admin.force-ai.co` — Vercel `app.forcemediakw.com` stays live until a deliberate DNS cutover       |
| **orders** (`apps/orders`) | `orders.force-ai.co` — Vercel `orders.forcemediakw.com` stays live until cutover                    |

The `custom_domain` routes create the `admin.`/`orders.force-ai.co` DNS records +
edge certs automatically on first deploy (needs the token's Zone DNS+SSL perms).

It runs on the **self-hosted WSL2 runner** by default (`vars.USE_SELF_HOSTED == 'true'`,
the same variable `ci.yml`/`deploy.yml` use), so it costs **zero GitHub Actions
minutes**. If the runner is offline, dispatch it manually with `force_cloud: true`
to fall back to `ubuntu-latest`.

## One-time setup

### 1. Create a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.

| Permission                             | Scope            |
| -------------------------------------- | ---------------- |
| Account › **Workers Scripts** › Edit   | Force AI account |
| Account › **Account Settings** › Read  | Force AI account |
| Zone › **Workers Routes** › Edit       | `force-ai.co`    |
| Zone › **DNS** › Edit                  | `force-ai.co`    |
| Zone › **SSL and Certificates** › Edit | `force-ai.co`    |

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

| Variable                       | Where it comes from                                            |
| ------------------------------ | -------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`          | `https://store-api.forcemediakw.com/api/v1` (workflow default) |
| `NEXT_PUBLIC_APP_NAME`         | `Force Store` (workflow default)                               |
| `NEXT_PUBLIC_SITE_URL`         | `https://store.forcemediakw.com` (workflow default)            |
| `NEXT_PUBLIC_ONESIGNAL_APP_ID` | _leave empty — storefront OneSignal not configured_            |
| `NEXT_PUBLIC_POSTHOG_HOST`     | `https://us.i.posthog.com` (workflow default)                  |
| `NEXT_PUBLIC_POSTHOG_KEY`      | Vercel `force-web` prod (`phc_…`)                              |
| `NEXT_PUBLIC_SENTRY_DSN_WEB`   | Vercel `force-web` prod (`https://…@…ingest.us.sentry.io/…`)   |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Vercel `force-web` prod (base64 `B…`)                          |

> The four values marked "workflow default" are baked into `cf-deploy.yml` as
> fallbacks, so you only strictly NEED to set the three from Vercel
> (`POSTHOG_KEY`, `SENTRY_DSN_WEB`, `VAPID_PUBLIC_KEY`) plus leave ONESIGNAL
> empty. Setting all eight is fine and makes the source of truth explicit.

That's it. The next push to `main` touching `apps/web/**` deploys automatically.

## What the workflow does

1. `npm ci`
2. Builds the workspace packages the storefront needs (`@force/database` → `@force/shared` → `@force/ui`)
3. `scripts/cf-setup-local.sh web` — installs the local-only OpenNext/wrangler devDeps and writes `apps/web/{open-next.config.ts,wrangler.jsonc}` **with the force-ai.co routes** (store + cf fallback + `*/*` SaaS catch-all)
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

This workflow deploys admin/orders to the **new** `admin.`/`orders.force-ai.co`
subdomains. The live Vercel domains (`app.forcemediakw.com`,
`orders.forcemediakw.com`) are **untouched** — verify the force-ai.co subdomains
work, then cut their DNS / rebrand when ready (and drop the Vercel projects after
a soak), exactly as wadyaljuz was cut over for the storefront.

## Follow-ups

- **Server-side Sentry** is inactive on the CF target for web + admin (the OpenNext
  build moves `instrumentation.ts` aside). Client-side Sentry works via each app's
  `instrumentation-client.ts`. Full SSR Sentry on Workers needs the
  `@sentry/cloudflare` SDK — separate task.
