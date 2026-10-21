# Security Overview — Ebda Store

Buyer-shareable answers to the standard security-questionnaire items. Every
claim below is derived from the code/config in this repo (file references in
parentheses are for internal verification; strip them when sharing externally).
Last verified: **2026-07-15**.

## Encryption

| Question                   | Answer                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data encrypted in transit? | Yes. TLS on every public endpoint (Cloudflare-fronted apps + API). HSTS is enforced at the API with `max-age=31536000; includeSubDomains; preload` (`apps/api/src/middleware/security.ts`).                                                                  |
| Data encrypted at rest?    | Yes. Primary database is Neon Postgres (AES-256 at rest). Object storage is Cloudflare R2 (encrypted at rest by default). Database backups are additionally encrypted client-side **before** upload to off-site storage (`.github/workflows/db-backup.yml`). |

## Vulnerability management

| Control                                                                                                 | Cadence                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit (`npm audit`, hard gate on high-severity prod deps)                                    | Every PR + every push to `main` (`.github/workflows/ci.yml`)                                                                                                                                                                                                                                                                    |
| Secret scanning (gitleaks)                                                                              | Every PR + every push to `main` (`.github/workflows/gitleaks.yml`)                                                                                                                                                                                                                                                              |
| Static analysis (semgrep)                                                                               | Every PR + every push to `main` (`.github/workflows/semgrep.yml`)                                                                                                                                                                                                                                                               |
| Dynamic scanning (OWASP ZAP baseline DAST against production storefront)                                | Nightly (`.github/workflows/zap-baseline.yml`, target `https://store.ebda.app`). **Alerts via a red job + Telegram + the report as a build artifact** — not a GitHub issue (changed 2026-09-11). Accepted alerts live in `.zap/rules.tsv` with `review-by:` dates, enforced nightly by `scripts/check-zap-review-dates.mjs`. |
| Manual penetration-test pass (Burp checklist)                                                           | Quarterly — see run log in `docs/security/burp-manual-pentest-checklist.md`                                                                                                                                                                                                                                                     |
| GitHub Action supply-chain pinning (every `uses:` ref pinned to a 40-hex commit SHA, not a mutable tag) | Refreshed weekly by Dependabot (`.github/dependabot.yml`); every PR gated by `scripts/check-action-pins.sh` (`.github/workflows/ci.yml`, `client-secret-scan` job) so a new unpinned ref cannot land                                                                                                                            |

Internal production audits run against 13+ dimensions (security surface,
tenancy/RLS/auth, money integrity, reliability, scaling, observability/DR,
deps) — dated reports live in `docs/audits/`.

## Access control

- Role-based access control enforced **at the API** (roles: super_admin /
  store_admin / staff / customer), with per-store ownership checks on every
  store-scoped route.
- A second, independent layer below the API: Postgres **row-level security**
  with `FORCE ROW LEVEL SECURITY` — the application's own connection cannot
  read cross-tenant rows outside an explicit, audited bypass helper.
- MFA is supported on admin accounts (recovery runbook:
  `docs/runbooks/mfa-recovery.md`).
- **Machine/agent access** (the store-scoped MCP endpoint, `POST
/api/v1/mcp/:storeSlug`) is split read/write. The 5 read tools and the MCP
  handshake are anonymous by design — that surface exists so AI shopping agents
  can find and evaluate a merchant's catalogue. The 2 tools that mutate
  (`add_to_cart`, `place_order`) require the store's own agent credential,
  presented as `x-agent-key`, stored AES-256-GCM-encrypted per store and
  compared ONLY against the store the URL slug resolved to, so a key issued for
  one merchant cannot write to another. Merchants mint/rotate/revoke it
  themselves on the **AI agent key** admin page (`/stores/:id/agent-key`; API
  `/stores/:id/integrations/agent-key`, store_admin + MFA); the plaintext is
  shown once, at mint time only, and never logged, cached, re-returned by the
  status endpoint, or used as a rate-limit key. Neither the plaintext nor the
  stored ciphertext leaves the API on any other read: the three `StoreService`
  wide reads omit the column, and all four properties are mutation-tested.
  Enforcement is ON by default; the `agent_checkout_open_writes` StoreFeature is
  a per-store escape hatch that disables it without a deploy (Rulings M1/M2,
  2026-09-09).
- Audit trail: security-relevant actions logged (`audit_logs`), 90 days hot,
  then archived to R2 for 7 years. Agent writes are recorded whether they
  succeed or not — `agent.write.denied` / `agent.write.failed` carry the caller
  ip and user agent, and a completed agent order's `payment.created` row carries
  both as well. `agent.write.denied` is coalesced to at most one row per
  (store, ip, tool, credential) per 60s — up to five per (store, ip, tool), one
  per credential outcome, because the alert classifier partitions on it (`DENIAL_COALESCE_WINDOW_SECONDS`, #1644 / #1649,
  owner ruling 2026-09-25) rather than one row per refused request — an
  unauthenticated caller could otherwise open a fresh interactive transaction
  per attempt at `publicLimiter`'s 300/min/IP ceiling. The FIRST denial in a
  window still writes its row through `runInTenantContext` exactly as before;
  every repeat in that window costs one plain, non-transactional `UPDATE` of
  that row's `details.count` rather than a new row or a new transaction — no
  attempt count is ever dropped, and a Redis outage fails open to one row per
  attempt (today's pre-coalescing behaviour). That `count` is a per-row DELTA:
  the Redis pointer stores the window counter's value its row started from,
  because the counter re-`EXPIRE`s on every attempt and so outlives the 60s
  pointer under a continuous flood — stamping the replacement row with the raw
  counter would restate attempts the previous row already carried and inflate
  the weighted totals the thresholds below read. `agent.write.failed` is
  coalesced the same way (under its own `agent:failed:` window) unless the
  caller presented a VALID key: with the `agent_checkout_open_writes` escape
  hatch on, an anonymous caller reaches `failed` trivially, so "requires
  credential possession" does not hold there (issue 2151). The window's first
  writer reserves its row slot before inserting, so a CONCURRENT burst also
  costs one transaction — repeats that see the reservation write nothing and
  the first writer flushes the total once its row exists (issue 2150). The
  source address is keyed by the same IPv6 prefix `publicLimiter` uses, and a
  Redis error on the counter falls back to a per-attempt row instead of
  writing none (issues 2054, 2141).
- Detection on refusals: `agent-write-denied-watch` (a 15-minute Inngest cron)
  reads the `agent.write.denied` rows and alerts through the Telegram channel.
  It classifies by what the caller PRESENTED — a lookup failure of ours (p0),
  a merchant integration presenting a stale key from a stable source (p1), a
  credential sweep from many sources (p1, escalating to one platform p0 across
  3+ stores), credential-less volume (info) — rather than on the raw denial
  rate, which is dominated by unauthenticated agents finding the tools through
  `llms.txt` and would get the alert muted. Every threshold weighs a row by
  its `details.count` (defaulting to 1 for a row that was never coalesced),
  not by row count, so coalescing denial rows never silently defeats a volume
  threshold. Thresholds and reasoning: `apps/api/src/mcp/agent-denial-alerts.ts`.

## Incident response

- Documented plan: `docs/INCIDENT.md` — severity matrix (P0–P3) with response
  times, detection sources (uptime monitoring, Sentry, deploy-failure alerts),
  and a step-ordered P0 triage checklist. Shareable on request.
- Rollback procedures: `docs/ROLLBACK.md` + `scripts/rollback.sh`.
- Vulnerability reports: `security@ebda.app` — policy in
  [`SECURITY.md`](../../SECURITY.md), machine-readable
  `/.well-known/security.txt` on all apps.

## Data residency

- Primary database: Neon Postgres, **AWS eu-central-1 (Frankfurt, Germany)**.
- Object storage: Cloudflare R2.
- CDN/edge: Cloudflare global network (sees encrypted traffic only).
- Data residency requirements per GCC country are tracked in
  `docs/privacy/data-map.md`; for Egypt, the applicable
  reference is the Electronic Transactions Law No. 20/2014. Erasure
  capability is provided platform-wide regardless (see Privacy below).

## Backups & disaster recovery

- Nightly encrypted off-machine database dump to a private R2 bucket
  (03:50 UTC, `.github/workflows/db-backup.yml`) — RPO ≤ 24h.
- Neon point-in-time recovery: **7 days** of history (restore to any second).
- Independent daily local dumps (30 rotations) as a third copy.
- Restore procedures documented and tested: `docs/ROLLBACK.md`.

## Privacy

- Record of processing activities / data map: `docs/privacy/data-map.md`
  (every PII category → where it lives, legal basis, retention, deletion path).
- Retention matrix: `docs/RETENTION.md`.
- Customer erasure: `POST /auth/me/erase` — irreversible PII anonymization,
  plus a monthly retention cron; third-party erasure propagated by event.
- Trackers are consent-gated (granular cookie-consent CMP); customer data is
  never fed to AI features.

## Defence verification

Security controls in the mutation-record-mandatory domains (authn/session,
tenant/RLS, money/payment/refund, consent, erasure, and — added 2026-09-09 —
agent identity, injection, enumeration, cache poisoning and availability) are
not merely covered by a
test — each is proven to FAIL when the control is removed. See
`docs/security/defence-mutation-record.md` (generated; spec in
`defence-mutations.json`, runner in `scripts/defence-mutation-record.mjs`). It
runs in CI on every PR touching a defended source and fails if any defence
survives its mutation, i.e. if a test would pass with the control deleted.

**Scope, precisely:** this per-defence record proves query-level guards — a
`WHERE storeId` clause, a permission check, a CAS on a claim column — mostly
at the `unit` tier. Six `integration`-tier entries run against a real,
migrated Postgres in the same CI job: `password-reset-bumps-token-version`
(`tests/integration/refresh-token-rotation.test.ts`), `money-wallet-row-lock`
(`tests/integration/customer-wallet.test.ts`),
`money-loyalty-reversal-index` (`tests/integration/partial-unique-indexes.test.ts`)
and the three admin/manual-order coupon controls — `money-admin-coupon-rules-enforced`,
`money-admin-coupon-override-role-gate` and `money-admin-coupon-atomic-reservation`
(`tests/integration/admin-order-coupon-rules.test.ts`, issues 2304/2317)
— the per-entry dependency reasoning is in `mutation-testing.yml`'s services
comment, which a unit test keeps in step with the spec. For **tenant/RLS**
specifically, it covers 7 such query-level guards; it does **not** cover the
session-GUC mechanism itself (`runInTenantContext` / `app.current_store_id` /
`app.current_user_id`, `apps/api/src/middleware/tenant-context.ts`) — that
runs under a REAL the earlier app role login role in a separate, dedicated CI job
(`test-rls-force-app` in `ci.yml`, driving `tests/integration/
rls-force-app.test.ts`), not in this record. Both are real, CI-blocking
proofs; they are just two different mechanisms; conflating them here would
overstate what a green `defence-mutation-record.md` alone proves about RLS.

## Evidence log

| Artifact                                    | Date       | Result                                                                                               |
| ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| ZAP baseline DAST — first activated run     | 2026-07-15 | 0 fail / 15 warn / 54 pass vs `https://store.ebda.app` (run 29426193025); warns queued for triage |
| Manual Burp pass                            | —          | no recorded run yet; first scheduled pass Q3 2026                                                    |
| 13-dimension internal audit sweep           | 2026-07-02 | 0 critical / 0 high open (`docs/audits/2026-07-02-MASTER-deep-audit.md`)                             |
| Security-readiness (procurement lens) audit | 2026-07-15 | `docs/audits/2026-07-15-security-readiness-enterprise-procurement.md`                                |

Append a row per pentest/DAST/audit run — this table is the "can we see it?"
answer.
