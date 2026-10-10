# Ebda truth table — 2026-10-10

What is actually built, actually deployed, and actually open, as of this writing. Every row cites a file:line, PR number, commit, or a live URL that was curled during this session (not re-derived from the stale 2026-10-04/05 docs). Re-run the curls before trusting this past its own session.

## 1. `origin/main` current state

- HEAD: `430cf31870f8df99a42aac6bd666d9c7bb60fb21` — `fix(api): bosta bundle accounts quote 0 egp instead of failing (#57)`.
- Live prod health, curled this session: `curl -s https://api.ebda.app/health` → `{"status":"ok","timestamp":"2026-10-10T02:39:36.710Z","commit":"430cf31870f8df99a42aac6bd666d9c7bb60fb21","deploymentId":"dffc9e84-5e6a-4cda-b5e3-7c869828c164"}`. **Re-verified current**: matches `origin/main` HEAD exactly.
- Also curled: `store.ebda.app` → 200, `ebda.app` → 200, `orders.ebda.app` → 200 (admin/web/orders Workers are reachable and serving).
- `deploymentId` is produced by `apps/api/src/lib/build-identity.ts:deploymentId()`, which reads `RAILWAY_DEPLOYMENT_ID` **before** `CF_DEPLOYMENT_ID` (both are UUID-shaped, so the value alone doesn't disambiguate which platform answered). See §5 for why this is no longer a safe assumption either way.

## 2. Open PRs (`gh pr list --repo Whisky-11/ebda --state open`)

All 3 open PRs are Dependabot GitHub Actions version bumps, all `MERGEABLE`, no app-code changes:

| # | Title | CI | Notes |
|---|---|---|---|
| 61 | `chore(deps): bump actions/upload-artifact from 7.0.1 to 7.0.2` | blast-radius + gitleaks SUCCESS; most CI jobs SKIPPED (no affected workspace); Unit Tests (affected) still QUEUED at check time | Mergeable, low risk |
| 60 | `chore(deps): bump trufflesecurity/trufflehog from 3.97.9 to 3.99.0` | queued/in-progress at check time | Mergeable |
| 59 | `chore(deps): bump actions/setup-node from 7.0.0 to 7.1.0` | blast-radius SUCCESS; rest queued/skipped | Mergeable |

No feature/fix PRs are open — everything from the recent burst of work (money batches, provider activation, bosta fix, kashier verified, onboarding fix) has already been merged into `main` (see commit list in §4).

## 3. Branches — AI-session carryover check

Searched `git branch -r` for `codex/`, `chatgpt/`, `grok/`-style naming. Two matches:

- `origin/codex/ebda-builder-roadmap` — last commit `docs: add Webstudio references for Ebda CMS`, authored by **Ahmad Sharaf** (not an AI-session branch despite the name), 2026-10-07. 0 commits ahead of `main`, 250 behind — fully stale/superseded, safe to delete.
- `origin/codex/ebda-pricing` — last commit `wip(pricing): rescue uncommitted locked-pricing work from /tmp`, authored by **Ahmad Sharaf**, 2026-10-07. 1 ahead, 262 behind — its content (locked Basic/Growth/Business pricing) **already landed on `main`** via `20261007000000_locked_pricing` migration + `4fc2ef3e feat(pricing): enforce locked Basic/Growth/Business entitlements` (see §4, D2/FIX-005). Stale, safe to delete.

No genuine ChatGPT/Grok-authored branches found. 9 other local-dev branches (`feat/kashier-verified`, `feat/provider-activation`, `fix/bosta-live-check`, `fix/lens4-trust`, `fix/money-a`, `fix/money-b`, `fix/order-money-gates`, `fix/provider-followups`, `hotfix/onboarding-provision`) are unmerged-by-ancestry only because their PRs were squash-merged — their commit content is already on `main` (confirmed by cross-referencing each branch's last commit message against `git log --oneline main`, e.g. `feat/kashier-verified`'s tip commit text matches `81d1270f` on main verbatim). All are stale remnants, safe to delete. `origin/plan` is the standing planning branch (per global CLAUDE.md convention) — leave it.

## 4. Cross-reference: STATUS.md (2026-10-04) and launch-readiness-2026-10-05.md vs current main

### `docs/ebda/plans/STATUS.md` claims

| Claim | Verdict | Evidence |
|---|---|---|
| SP10 research done | CONFIRMED-STILL-TRUE | `docs/ebda/research/` unchanged |
| SP3 design + Workers spike done | CONFIRMED-STILL-TRUE, **now exceeded** | `spikes/workers-api/` still present, but the spike has since been turned into an actual deploy pipeline — `apps/api/wrangler.jsonc` + `.github/workflows/cf-api-deploy.yml` (added `23acd07b`, 2026-10-05) have run **9 times successfully** against production since 2026-10-07 (`gh run list --workflow cf-api-deploy.yml`). See §5. |
| SP4 clone+rebrand "done, deploy waits on CF token + Neon" | **NOW-FALSE** | CF token/account/Hyperdrive/KV are provisioned: `gh variable list` shows `CLOUDFLARE_ACCOUNT_ID`, `EBDA_HYPERDRIVE_ID`, `EBDA_KV_CACHE_ID` all set since 2026-10-07T02:03. Admin/web/orders are live on CF Workers (curled 200 this session). |
| SP5 self-serve+billing "done except timed human run" | STILL-OPEN (narrowly) | No evidence a human-timed onboarding run happened since; this is a one-person-must-do-it item, can't be verified from source |
| SP6 payments "done against stubs; 6c real sandboxes waits on keys" | **PARTIALLY NOW-FALSE** | Kashier is now real-sandbox-verified: `packages/shared/src/providers/catalog.ts:264-266` `verified: true, sandboxVerifiedAt: '2026-10-08'`, commit `81d1270f feat(shared): mark kashier verified after a real sandbox run`. Paymob/Fawry remain `verified: false` with explicit "not yet run against a test account" notes (`catalog.ts:151-154`, `:350-353`) — still open, same framework (`scripts/provider-sandbox-check.mjs`) now exists to close them. |
| SP7 shipping "done against stubs; sandboxes wait on keys" | STILL-OPEN | `catalog.ts:449-452` Bosta `verified: false`; `:639` Aramex `verified: false` — unchanged, still waiting on real carrier test accounts |
| SP8 WhatsApp free tier done | CONFIRMED-STILL-TRUE | `apps/help/content/en/whatsapp-buttons.mdx:3` still "Free click-to-chat WhatsApp buttons... using wa.me links"; no Cloud API bot code added |
| SP9 site/docs/help/status "build+gates done, deploy waits on credentials" | **NOW-FALSE** (deploy no longer waits) | marketing/docs/help/status are Workers apps per `apps/{marketing,status}/wrangler.jsonc`; `ebda.app`/`store.ebda.app`/`orders.ebda.app` all curl 200 live |
| Ahmad decision #1 "prices per plan" | **RESOLVED** | `docs/plans/2026-10-05-pricing-decisions.md` approved, landed in `20261007000000_locked_pricing` migration + `apps/marketing/src/lib/plans.ts` (reads from DB, no more hardcoded nulls) + `tests/unit/locked-pricing.test.ts` (Basic/Growth/Business = 149000/349000/999000 minor EGP, platformFeeBps 0 on every plan). This is also FIX-004/FIX-005 — see Deliverable 2. |
| Ahmad decision #4 "enable GH Actions, set default branch to main" | **RESOLVED** | CI clearly running (`gh pr list` shows live check runs); `origin/HEAD -> origin/main` confirms default branch |
| Ahmad decision #8 "CI trade-off: weekly integration/e2e" | STILL-OPEN as described, but superseded in practice | current CI (seen on the 3 open PRs) runs Integration/E2E/RLS-proof/Mutation-tests per PR already (all appear in the per-PR check list), not weekly-only — the weekly cadence described in `docs/ebda/ci.md` appears to have been tightened since; not independently re-read this session for budget reasons |

### `docs/ebda/launch-readiness-2026-10-05.md` claims

| Claim | Verdict | Evidence |
|---|---|---|
| "Core backend wiring runs in local Cloudflare workerd. This is not yet a verified live deployment." | **NOW-FALSE** | `cf-api-deploy.yml` has deployed and health-verified against production `api.ebda.app` 9 times since 2026-10-07 (one of ten runs failed, `37800383665`, rest succeeded); admin/web/orders are live. This is the single largest factual gap between the stale docs and current reality. |
| "Cloudflare deployment: Company inventory has no Hyperdrive configs and no Ebda KV; GitHub repo secrets/variables list empty" | **NOW-FALSE** | `gh variable list --repo Whisky-11/ebda` shows `EBDA_HYPERDRIVE_ID`, `EBDA_KV_CACHE_ID`, `CLOUDFLARE_ACCOUNT_ID` all set 2026-10-07T02:03 |
| "Gateways/carriers ... requires actual sandbox inputs" | PARTIALLY NOW-FALSE | Kashier closed (real sandbox, 2026-10-08). Paymob/Fawry/Bosta/Aramex/shipping carriers still open — STILL-OPEN for those |
| "Provision Ebda KV and all declared queues/DLQs" | **NOW-FALSE** (provisioned) | `apps/api/wrangler.jsonc` declares `ebda-email`/`ebda-sms` queues + DLQs; `EBDA_KV_CACHE_ID` is a real repo variable, not a placeholder, at deploy time (`scripts/ebda-cf-api-config.mjs` substitutes it into `.wrangler.deploy.jsonc` before `wrangler deploy`) |
| Redis reliance on Railway only | **NOW-FALSE** for the Workers runtime | `475c5a21 feat(api): redis on workers via the authstate durable object and kv` replaces ioredis with a Durable-Object + KV-backed shim (`cf/ioredis-cf.ts`) for the Workers shell; Node/Railway shell still uses real Redis |
| LAUNCH-2/3/4 rulings (basic-ftp patched, braces/extract-zip residual, broad unit failures were sandbox artefacts) | CONFIRMED-STILL-TRUE, now formalized | Same residuals re-ruled with fresh evidence as `AUDIT-11b`/`AUDIT-11c` in `docs/RULINGS.md:5558-5560` (2026-10-07 re-check superseding the original LAUNCH-2/3 wording) |

**Headline finding:** both stale docs understate how far CF migration has progressed. Neither doc has been refreshed since 2026-10-04/05, but 250+ commits have landed since, including a full production-track Cloudflare deploy pipeline for the API (not just the SP3/SP4 "local workerd" spike they describe). This is itself a live instance of what Deliverable 2's FIX-016 flags: the docs need a refreshed evidence hierarchy before any readiness claim is republished.

## 5. CF + Neon migration — binding rule: Ebda doesn't launch until everything is on CF + Neon

| Service | On CF+Neon today? | Evidence | Migration step / blocker |
|---|---|---|---|
| Admin (`apps/admin`) | YES — CF Workers | `curl https://store.ebda.app` → 200; `apps/admin/wrangler.jsonc` exists | None — done |
| Web/storefront (`apps/web`) | YES — CF Workers | `curl https://ebda.app` → 200; `apps/web/wrangler.jsonc` exists | None — done |
| Orders (`apps/orders`) | YES — CF Workers | `curl https://orders.ebda.app` → 200; `apps/orders/wrangler.jsonc` exists | None — done |
| Marketing/status/docs/help | YES — CF Workers/Pages | `apps/marketing/wrangler.jsonc`, `apps/status/wrangler.jsonc` present | None — done |
| Postgres | YES — Neon | Confirmed by CLAUDE.md + Prisma/Hyperdrive wiring throughout | None — done |
| **API (`apps/api`)** | **UNCERTAIN — likely already migrated or mid-cutover, needs direct confirmation** | Contradictory signals: (a) this repo's own `CLAUDE.md` architecture section, last touched 2026-10-08, still says the API "runs on Railway (Dockerfile.api)... served via the Cloudflare custom domain `api.ebda.app` as a reverse proxy"; (b) but `.github/workflows/cf-api-deploy.yml` (added 2026-10-05) deploys `apps/api` as a genuine CF Worker **bound to that exact same custom domain** (`"routes": [{"pattern": "api.ebda.app", "custom_domain": true}]` in `apps/api/wrangler.jsonc`), and has run successfully **9 of the last 10 times** since 2026-10-07, each run polling `https://api.ebda.app/health` and auto-rolling-back if the deployed commit isn't live; (c) there is **no `railway.json` and no `railway-deploy.yml` anywhere in this repo** (only `docs/migration/railway-actions-deploy.md`, itself stale since 2026-09-30, describing a workflow file that doesn't exist here) — meaning if Railway is still serving, it's via Railway's un-reviewable dashboard GitHub-App auto-deploy, not anything in this repo; (d) `railway` CLI in this sandbox is logged in to the right account (`forceai.0ps1@gmail.com`) but lists no `ebda` project, so Railway's current state for Ebda could not be checked from here. **Cloudflare Custom Domains bind a hostname exclusively to one Worker**, so a successfully-verified `wrangler deploy` against `api.ebda.app` is strong evidence the Worker is the one actually answering — but this was not independently confirmed via the Cloudflare dashboard/API (no credentials available in this sandbox). | **Ask Ahmad to check the Cloudflare dashboard directly**: does `ebda-api` show as the Worker bound to the `api.ebda.app` custom domain? If yes, the migration is effectively done — decommission the Railway service to realize the CF+Neon cost goal. If Railway is still answering (meaning the custom domain binding failed silently or routes through a different hostname pattern than assumed here), the blocker is identifying why `cf-api-deploy.yml`'s own health-verify step (`scripts/ci/deploy-guard.mjs verify`, which polls the exact public hostname and fails/rolls back the job otherwise) has been reporting success. |
| **Redis** | **Workers shell: YES (Durable Object + KV); Node/Railway shell: NO** | `475c5a21 feat(api): redis on workers via the authstate durable object and kv` ships `cf/ioredis-cf.ts`, an ioredis-shaped shim over the `AuthState` Durable Object (jti denylist, token versions, MFA/lockout, CSRF, locks, Lua-script ops) + KV (`cache:*`, 60s TTL floor). The Node/Railway shell still talks to real Railway-internal Redis. | If the API has in fact cut over to Workers (see row above), Railway Redis is now vestigial and can be decommissioned once confirmed unused; if the API is still on Railway/Node, Redis migration is blocked on the same API cutover decision. |

**Bottom line for the binding rule:** the only concretely-still-on-Railway piece, if the API cutover is NOT yet real, is the API + its Redis. Everything else (admin, web, orders, marketing, docs, help, status, Postgres) is already CF+Neon. The size of the remaining gap hinges entirely on one unresolved factual question (API: Railway or Workers, right now?) that this session could not settle without Cloudflare dashboard/API access — flagged above as the most important thing to check next.
