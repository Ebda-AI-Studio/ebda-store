# Service Level Objectives (SLOs) — Force Website Builder

_Last updated: 2026-06-09. Review cadence: quarterly and after any P0 incident._

Monitoring stack: **Sentry** (error budgets, latency sampling) · **UptimeRobot** (external availability probes) · **pino** structured logs → **Axiom** (log drain, query on demand).

---

## 1. api — Express.js (Railway)

| SLO                            | Target       | Error Budget (30 days)                                           | Measurement                                           |
| ------------------------------ | ------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Availability                   | **99.5 %**   | 216 min / month downtime                                         | UptimeRobot HTTP monitor at `GET /health` every 1 min |
| p95 latency (non-AI routes)    | **< 800 ms** | Sentry Perf `p95(http.server.duration)` on `txn != *ai*`         |
| p95 latency (AI/Gemini routes) | **< 5 s**    | Sentry Perf `p95(http.server.duration)` on `txn = *ai*`          |
| Error rate (5xx)               | **< 0.5 %**  | Sentry `issue_type:error AND level:error` / total requests       |
| Checkout success rate          | **> 99 %**   | Sentry custom metric `checkout.completed` / `checkout.initiated` |

**Burn-rate alerts (Sentry):**

- 1 h window exceeds 14× normal burn → page on-call immediately (consumes 2 % budget in 1 h).
- 6 h window exceeds 6× normal burn → Telegram alert.

---

## 2. admin — Next.js (Vercel)

| SLO                             | Target                    | Error Budget (30 days)                       | Measurement                           |
| ------------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------- |
| Availability (Vercel edge)      | **99.9 %**                | 43 min / month downtime                      | UptimeRobot on `app.forcemediakw.com` |
| Core Web Vitals — LCP (desktop) | **< 2.5 s**               | Lighthouse CI nightly job · Vercel Analytics |
| Core Web Vitals — CLS           | **< 0.1**                 | Same                                         |
| JS error rate                   | **< 0.1 %** of page loads | Sentry `NEXT_PUBLIC_SENTRY_DSN` capture      |

---

## 3. web (storefront) — Next.js (Vercel)

| SLO                            | Target       | Error Budget (30 days)                              | Measurement                        |
| ------------------------------ | ------------ | --------------------------------------------------- | ---------------------------------- |
| Availability (Vercel edge)     | **99.9 %**   | 43 min / month downtime                             | UptimeRobot on per-tenant root URL |
| Core Web Vitals — LCP (mobile) | **< 2.5 s**  | Lighthouse CI nightly · Vercel Real User Monitoring |
| Core Web Vitals — CLS          | **< 0.1**    | Same                                                |
| Time to First Byte (TTFB)      | **< 200 ms** | Vercel Analytics p75 TTFB (ISR/SSR pages)           |
| JS error rate                  | **< 0.1 %**  | Sentry storefront capture                           |

---

## 4. Distributed Tracing (OpenTelemetry)

OTel tracing is wired in `apps/api/src/tracing.ts` behind the

> **LIVE since 2026-07-12:** exports to Grafana Cloud Tempo — stack `brownoak2576` (https://brownoak2576.grafana.net, prod-eu-west-2, free tier 50GB traces). Railway `api` service carries `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` (Basic auth, instance `1720967`, access policy `force-api-otlp`). View: Grafana → Explore → Traces. Verified end-to-end (force-api spans incl. redis + http).
> `OTEL_EXPORTER_OTLP_ENDPOINT` env flag. When the var is set, spans are exported
> via OTLP/HTTP and trace context (`traceparent`) propagates through all downstream
> HTTP calls (Neon, Redis, Inngest, Gemini).

**Recommended exporters:** Grafana Tempo (free in cloud tier) · Honeycomb · Jaeger
(self-hosted). Set `OTEL_SERVICE_NAME=force-api` and
`OTEL_EXPORTER_OTLP_ENDPOINT=<collector-url>` in Railway env vars.

Sample rate: 10 % in production (`OTEL_TRACES_SAMPLER_ARG=0.1`), 100 % in dev.
Override with `OTEL_TRACES_SAMPLER=always_on` for debugging a specific incident.

---

## 5. Error Budget Policy

| Budget remaining | Action                                                     |
| ---------------- | ---------------------------------------------------------- |
| > 50 %           | Business as usual — ship features                          |
| 25 – 50 %        | Slow down risky deploys; review on-call runbook            |
| < 25 %           | Feature freeze on API · prioritise reliability fixes       |
| 0 %              | Incident declared · postmortem required before next deploy |

---

## 6. Runbook References

- **P0 incident:** `docs/INCIDENT.md`
- **Rollback procedure:** `docs/ROLLBACK.md`
- **Alerting bridge:** `apps/api/src/services/alerts.service.ts` (Telegram)
- **UptimeRobot:** configured in `docs/runbooks/` per Ahmad's account
- **Sentry DSN:** set via `SENTRY_DSN` Railway env var (API) and `NEXT_PUBLIC_SENTRY_DSN` Vercel env var (admin/web)
