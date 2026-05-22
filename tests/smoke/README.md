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

- Storefront: `https://wadyaljuz.com`
- Admin: `https://app.forcemediakw.com`

## Running a single project

```bash
npm run test:smoke -- --project=storefront
npm run test:smoke -- --project=admin
```

## CI integration (post-deploy)

Today these are not yet wired into `.github/workflows/ci.yml`. The intent is to run them as a separate post-deploy job (after Railway + Vercel deploys finish) — Track D in the ongoing audit cleanup covers wiring this in. To wire it manually:

```yaml
smoke:
  runs-on: ubuntu-latest
  needs: deploy
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
    - run: npm ci
    - run: npx playwright install --with-deps chromium
    - run: npm run test:smoke
    - uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: playwright-report
        path: playwright-report/
```

## Why not just hit `/api/health`?

Health endpoints check the API. These smoke specs check that the deployed front-end shell still renders and routes still respond — three layers downstream of `/health` (Vercel build + CDN + client hydration). A green health endpoint with a white-screen storefront is a real failure mode (verified during the Next 16 + Turbopack rollouts).

## What NOT to add here

- Anything that writes to the prod DB (orders, account creation, cart sync, addresses)
- Anything that requires real credentials (admin login, payment flow)
- Anything that exercises a single tenant's data deeply — smoke is platform shell, not tenant content
- Flaky timing-dependent assertions ("wait 5s then check") — use Playwright `expect.poll` or `waitForURL`

For deeper coverage, write a normal e2e under `tests/e2e/` (Vitest + supertest, API-level) or extend the integration suite under `tests/integration/`.
