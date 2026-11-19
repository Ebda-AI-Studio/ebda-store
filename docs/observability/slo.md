# Service Level Objectives (SLOs) — Ebda Store

_Last updated: 2026-11-10 (rewritten for the Cloudflare stack, Iceberg audit #25). Review cadence: quarterly and after any P0._

Monitoring stack: **status.ebda.app** (Worker `ebda-status`: external probes every 5 min, 15 s timeout, a response over 8 s is shown Degraded (not paged), incident after
2 consecutive failures or 2 slow probes in a row = detection in 5-10 min, Telegram on open/resolve) · **Sentry** (errors, api/web/admin/orders) · **Workers Logs +
Logpush** to R2 `ebda-logs` (30 days) · **Cloudflare Web Analytics** (page speed, no cookies) · **API alert bridge →
Telegram** (`apps/api/src/services/alerts.service.ts`). Neon, Railway, Axiom and UptimeRobot are retired.

**Where we are (measured on status.ebda.app, 2026-11-09/10): storefront probes 90.6-97 %, with "timeout after 8000 ms"
incidents from cold SSR. The 99.9 % storefront target below is NOT met today**; the perf work (edge redirect, render
cost, caching) is what closes it. Until it is met, every Telegram probe alert is a real miss, not noise.

**Status page window (Ruling STATUS-WINDOW-1).** status.ebda.app headlines the LAST 30 DAYS per component and shows the 90-day figure beside it; `/api/status.json` has `uptime30d` next to `uptime` (90 days). The SLO tables below are measured on the 30-day figure.

**Probe coverage (audited 2026-11-17).** Probers: the status Worker (`apps/status`, cron every 5 min, Telegram on open/recover) and the AI OS brain Worker (prod-watch on its cron, every 10 min, same host list). Both run INSIDE Cloudflare, so a Cloudflare-wide outage is invisible to them; the outside-in GitHub-hosted Prod watch is disabled (no GitHub-hosted runners, by decision), and the Mac cannot be the external vantage (the Egyptian ISP blocks Cloudflare's 188.114.96/97 range). Storefront coverage was two demo stores on `*.ebda.app`; the custom-domain path of a live merchant store (ameliaaurum.com) had NO probe until the `storefront-custom-domain` component (measured 0.7-4.6 s first byte on a bare curl before it existed). 7-day status results (2026-11-11..17): api, admin, orders, accounts, marketing, docs, help 100 %; chat 100 %; storefront 98.06 %; storefront product 96.8 %, all misses on 11-11..15 and none from 11-16 (before the store-resolve fix deployed; re-measure after it).

## 1. api — `ebda-api` (Worker, D1 + Durable Objects)

| SLO                         | Target       | Error budget (30 d) | Measurement                                                     |
| --------------------------- | ------------ | ------------------- | --------------------------------------------------------------- |
| Availability                | **99.5 %**   | 216 min             | status.ebda.app "API" probe (`GET /health`, 200 + `status: ok`) |
| p95 latency (non-AI routes) | **< 800 ms** |                     | Workers Logs (`wallTime`) / Sentry performance                  |
| p95 latency (AI routes)     | **< 5 s**    |                     | same, AI routes                                                 |
| 5xx rate                    | **< 0.5 %**  |                     | Workers Logs `Outcome` + status codes; Sentry error events      |

## 2. storefronts — `ebda-web`

| SLO           | Target       | Error budget (30 d) | Measurement                                                                     |
| ------------- | ------------ | ------------------- | ------------------------------------------------------------------------------- |
| Availability  | **99.9 %**   | 43 min              | status.ebda.app "Storefronts" + "Storefront product pages" probes               |
| TTFB p75      | **< 200 ms** |                     | Cloudflare Web Analytics; spot check `curl -w '%{time_starttransfer}'` on `/ar` |
| LCP (mobile)  | **< 2.5 s**  |                     | Cloudflare Web Analytics / Lighthouse                                           |
| CLS           | **< 0.1**    |                     | same                                                                            |
| JS error rate | **< 0.1 %**  |                     | Sentry (web)                                                                    |

## 3. merchant surfaces — `ebda-admin`, `ebda-orders`, `ebda-accounts`

| SLO           | Target      | Measurement                                                   |
| ------------- | ----------- | ------------------------------------------------------------- |
| Availability  | **99.9 %**  | status.ebda.app "Merchant dashboard", "Orders app", "Sign-in" |
| JS error rate | **< 0.1 %** | Sentry (admin, orders)                                        |

## 4. data protection

| Objective          | Target                                               | Measurement                                                         |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| RPO (nightly dump) | **≤ 24 h** (D1 Time Travel / DO PITR: seconds, 30 d) | `cf-backup.yml` green every night; failure pages Telegram           |
| Restore proven     | weekly                                               | `cf-backup-drill.yml` (D1 platform + identity + StoreDO round-trip) |
| Off-account copy   | ≤ 2 days old                                         | Mac launchd `app.ebda.cf-backup-pull` (alerts when older)           |

## 5. Error budget policy

| Budget remaining | Action                                                       |
| ---------------- | ------------------------------------------------------------ |
| > 50 %           | ship features                                                |
| 25 – 50 %        | slow down risky deploys                                      |
| < 25 %           | feature freeze on the failing surface; reliability work only |
| 0 %              | incident declared; postmortem before the next deploy         |

## 6. Tracing

OpenTelemetry (`apps/api/src/tracing.ts`) is imported only by the Node entry (`apps/api/src/index.ts`, local dev). The
production Worker entry does not load it, so there is **no distributed tracing in production** today; use Workers Logs
(per-request `wallTime`, `cpuTime`, subrequests) and Sentry.

## 7. References

- P0 triage: `docs/INCIDENT.md` · escalation: `docs/ops/escalation.md` · rollback: `docs/ROLLBACK.md`
- Probe list + thresholds: `apps/status/src/config.ts` (`DEFAULT_TIMEOUT_MS`, `DEFAULT_FAIL_THRESHOLD`, `DEFAULT_RECOVER_THRESHOLD`)
- Logs: `docs/DEPLOYMENT.md` §7 · Sentry DSNs: `docs/ENVIRONMENT.md`
