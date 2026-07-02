# Cloudflare migration readiness — Force AI Vercel fleet

> Status: **VALIDATED FEASIBLE** (spike run 2026-06-19). Frontend-only, hybrid move — Express API stays on Railway, R2 storage stays. This doc is the costed migration recipe, not a commitment to move.

## TL;DR

- **Move now?** No. At ~3 live stores on paid Vercel Pro it saves ≈ $0 and adds risk.
- **Why it's coming:** the 100+ store **all-custom-domain** future is a Cloudflare architecture (Cloudflare for SaaS = ~$0.10/hostname, free egress, cheap requests). At scale Cloudflare is ~5–10× cheaper than Vercel's usage-based billing, primarily on egress + edge requests + per-tenant domains.
- **Target stack:** Cloudflare **Pages (OpenNext)** for the Next frontends + **Cloudflare for SaaS** for per-tenant custom domains + **R2** (already there) + Express API unchanged on Railway.
- **Not Firebase** — adds a 4th vendor, no clean custom-hostname-SaaS equivalent, no R2 synergy.
- **Validated:** Next 16.2.9 builds under `@opennextjs/cloudflare@1.19.11`; monorepo traces correctly; `.open-next` output ~4.4 MB (well under CF's 10 MB Worker limit). The only build blockers are **Node-native server deps** that don't run on Workers — a small, enumerated list (below).

## Adapter compatibility — entire fleet is supported

`@opennextjs/cloudflare@1.19.11` peer range: `next: ">=15.5.18 <16 || >=16.2.6"`.

| Project                          | Next          | OpenNext                                       |
| -------------------------------- | ------------- | ---------------------------------------------- |
| FWB web / admin / orders         | 16.2.9        | ✅                                             |
| om-hassan-menu                   | 16.2.6        | ✅                                             |
| digital-card                     | 16.2.6        | ✅                                             |
| WBS frontend                     | `^16.0.10`    | ✅ (pin lockfile ≥ 16.2.6 — `npm update next`) |
| Force Media CRM                  | `^16.0.10`    | ✅ (same lockfile nudge)                       |
| force-media-landing / al_assriya | static/simple | ✅ trivial on Pages                            |

No adapter blocker anywhere.

## The only real blockers: Node-native server deps (don't run on Workers)

Cloudflare Workers is **not Node** — native binaries (`sharp`) and Node-runtime SDKs (Sentry Node + OpenTelemetry, loaded via `instrumentation.ts`) can't execute. The `next build` succeeds; OpenNext's bundler then can't resolve/trace these. Fleet scan (`instrumentation` / `sharp` / `@sentry/node` / OTel / other native):

| Project             | `instrumentation` (Sentry-node) | `sharp` (OG/image)        | Verdict        |
| ------------------- | ------------------------------- | ------------------------- | -------------- |
| **FWB web**         | ✔                               | ✔ (`opengraph-image.tsx`) | 2 fixes        |
| **FWB admin**       | ✔                               | —                         | 1 fix (shared) |
| **FWB orders**      | —                               | —                         | **clean**      |
| **WBS frontend**    | ✔                               | —                         | 1 fix (shared) |
| **Force Media CRM** | —                               | —                         | **clean**      |
| **om-hassan-menu**  | —                               | — (OG via `next/og`)      | **clean**      |
| **digital-card**    | —                               | — (OG via `next/og`)      | **clean**      |

**The entire fleet = two distinct fixes.** Four projects already clean.

## The migration recipe (per blocker)

### 1. `instrumentation.ts` — server Sentry (Node SDK) → Workers

Affects: FWB web, FWB admin, WBS frontend. The hook loads `@sentry/nextjs` + `sentry.server.config.ts` for the Node runtime; that won't run on Workers, and OpenNext can't trace the compiled `server/instrumentation.js` in the monorepo standalone.

- **Fix:** use **`@sentry/cloudflare`** (Workers SDK) for the server side, or gate the Node instrumentation to only load when `NEXT_RUNTIME === 'nodejs'` AND not on Workers. One shared change.
- **Status (2026-07-02): done for FWB web** — `apps/web/sentry-worker-entry.ts` wraps the OpenNext Worker fetch handler with `Sentry.withSentry(...)`; see `cloudflare-ci-deploy.md` Follow-ups for the exact wiring. FWB admin + WBS frontend still need the same treatment.

### 2. `opengraph-image.tsx` — `sharp` → `next/og`

Affects: FWB web only. The dynamic OG-image route composes images with native `sharp`.

- **Fix:** rewrite with **`next/og`'s `ImageResponse`** (Satori — edge/Workers-native, no sharp), or move OG generation to the Railway backend. One file.

### 3. Image optimization

- Set **`images.unoptimized: true`** — R2 images are already backend-`sharp`-resized on upload, so no quality loss. Or wire a Cloudflare Image Resizing loader.

### 4. Per-tenant custom domains (the scale driver)

- Replace the Vercel domain-provisioning code with the **Cloudflare for SaaS Custom Hostnames API** (auto-SSL per hostname). Purpose-built for hundreds of tenant domains; ~$0.10/hostname/mo, 100 free.

## Cost forecast @ 100 stores (≈8.4M pageviews/mo, mixed traffic)

| Scenario                                | Vercel        | Cloudflare |
| --------------------------------------- | ------------- | ---------- |
| Good ISR/edge caching (current pattern) | ~$300/mo      | ~$35/mo    |
| High traffic / weak caching             | $500–1,500/mo | $50–150/mo |

Driver: Cloudflare **free egress + cheap requests + $0.10 hostnames**. Product images already on R2 (egress-free) compounds the saving. _Caching is the #1 cost lever on either platform — do it regardless._

## Dual-run plan (run both until validated, then cut over per-tenant)

Low-risk because the backend (Railway) + images (R2) are shared, and DNS is per-domain:

1. Vercel stays prod (untouched).
2. Cloudflare Pages builds the same `web` repo in parallel → `*.pages.dev`. Validate render. Zero prod impact.
3. Point one demo/test domain at Cloudflare via Cloudflare for SaaS → prove the custom-hostname + SSL flow.
4. Canary: move 1–2 low-risk stores' domains, watch cost + Core Web Vitals for a couple weeks.
5. Migrate domains in batches; decommission Vercel when the last store moves. Overlap cost during eval ≈ $25/mo.

## Effort estimate

- FWB pattern (web/admin/orders): the 2 shared fixes (Sentry-cloudflare + OG/next/og + `unoptimized`) ≈ **0.5–1 day**.
- Cloudflare-for-SaaS hostname flow (swap provisioning code) ≈ **1–2 days**.
- Per-project: WBS frontend (instrumentation fix only), CRM/om-hassan/digital-card (clean — config + deploy).
- **Realistic total to a validated, dual-running cutover-ready state: ~1–2 weeks** focused, then incremental per-tenant migration.

## Status (2026-06-24) — code-ready, env-gated

**DONE (in the repo, behind env, zero Vercel impact):**

- `DomainProvider` abstraction + `resolveDomainService(store)` — picks provider from per-store `Store.domainProvider` → `DOMAIN_PROVIDER` env → `vercel` default (9/9 unit tests).
- `CloudflareDomainService` — Cloudflare-for-SaaS Custom Hostnames API (create / status / delete), no-ops until `CF_*` set.
- Provisioning + `GET`/`PUT /:id/domain` route through the resolver (Vercel stays default).
- Super-admin `PATCH /:id/domain-provider` + admin Domain-page provider switch.
- `scripts/cf-setup-local.sh` (clone the git-ignored OpenNext build files) + `scripts/cf-migrate-store.sh` (per-tenant cutover + `--rollback`).
- **[`cloudflare-cutover-runbook.md`](./cloudflare-cutover-runbook.md)** — the step-by-step procedure.

**REMAINING (live activation, Ahmad):** enable SSL-for-SaaS on a CF zone, create the API token + fallback origin, set `CF_API_TOKEN`/`CF_ZONE_ID`/`CF_FALLBACK_ORIGIN` in Railway, then run the canary per the runbook.

## Trigger to actually move

When monthly Vercel **usage** (above the $20 base) consistently crosses ~$300–500/mo, **or** when onboarding custom-domain stores at volume (~15–25+). Until then: stay on Vercel, keep storefronts ISR/edge-cached, keep images on R2, and avoid Vercel-only lock-in (Edge Config, Vercel KV/Postgres/Cron) so the move stays a config swap.

---

_Spike artifacts: `@opennextjs/cloudflare@1.19.11` + `wrangler@^4.86.0` on a throwaway `spike/opennext-cloudflare` worktree; `next build` validated; blockers isolated to `instrumentation.ts` + `opengraph-image.tsx` (sharp). Re-run with `npx opennextjs-cloudflare build` after the 2 fixes for a fully-clean Worker bundle._
