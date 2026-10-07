# Playwright smoke tests

Lightweight, read-only browser tests that hit a deployed environment (default: production) and verify the storefront + admin shells still render. Designed to run post-deploy as a sanity check, not as a full e2e suite.

## What they cover

**Storefront** (`storefront.smoke.spec.ts`)

- Home page returns 200 + has `<header>` / `<main>` / `<footer>` + no critical console errors
- Clicking the first product card navigates to a PDP (`/products/<slug>`)
- `/cart` route reaches the shell without a 5xx

**Admin** (`admin.smoke.spec.ts`)

- `/login` renders email + password inputs + submit button
- `/dashboard` redirects unauthenticated visitors to `/login`

No DB writes. No checkout. No auth. If smoke fails on prod, treat it as "deploy broke the shell" — go look at the latest deploy.

## Running locally

```bash
# First-time setup: install Chromium + system deps (one-time per workstation)
npm run test:smoke:install

# Run all smoke specs against prod
npm run test:smoke

# Open the last HTML report
npm run test:smoke:report
```

## Targeting a different environment

Both URLs are env-var overridable:

```bash
SMOKE_STOREFRONT_URL=https://staging.example.com \
SMOKE_ADMIN_URL=https://staging-admin.example.com \
  npm run test:smoke
```

Defaults:

- Storefront: `https://wadyaljuz.com` — in CI the `smoke-test` job reads the
  `SMOKE_STOREFRONT_URL` repo Actions **variable** first (falling back to
  wadyaljuz.com), so the reference merchant can change without a code change.
  The platform host (`ebda.app`) serves the landing page with no
  product links, so it cannot satisfy the PDP test — the target must be a
  live merchant storefront with at least one published product.
- Admin: `https://admin.ebda.app` (corrected 2026-09-02 — `admin.ebda.app`
  now 301-redirects here since the Cloudflare migration; it still "works" via the
  redirect but every baseURL-relative check was really exercising the redirect
  target under the wrong URL)

## Running a single project

```bash
npm run test:smoke -- --project=storefront
npm run test:smoke -- --project=admin
```

## CI integration (post-deploy)

**Wired in as of 2026-09-02** — the `smoke-test` job in
`.github/workflows/cf-deploy.yml` runs the `storefront` + `admin` chromium
projects (not the full 5-browser matrix — that's for local/manual runs)
after `deploy-web`/`deploy-admin` complete, and feeds its result into the
same Telegram alert `notify-failure` sends for a deploy failure. `orders`
has no smoke coverage yet, so it doesn't gate this job. Before this, the
suite existed and passed locally but had zero references in any workflow —
a broken storefront/admin shell was detected by users, not by the repo.

## Why not just hit `/api/health`?

Health endpoints check the API. These smoke specs check that the deployed front-end shell still renders and routes still respond — three layers downstream of `/health` (Vercel build + CDN + client hydration). A green health endpoint with a white-screen storefront is a real failure mode (verified during the Next 16 + Turbopack rollouts).

## What NOT to add here

- Anything that writes to the prod DB (orders, account creation, cart sync, addresses)
- Anything that requires real credentials (admin login, payment flow)
- Anything that exercises a single tenant's data deeply — smoke is platform shell, not tenant content
- Flaky timing-dependent assertions ("wait 5s then check") — use Playwright `expect.poll` or `waitForURL`

For deeper coverage, write a normal e2e under `tests/e2e/` (Vitest + supertest, API-level) or extend the integration suite under `tests/integration/`.
