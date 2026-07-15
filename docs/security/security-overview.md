# Security Overview — Force Website Builder

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

| Control                                                                  | Cadence                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Dependency audit (`npm audit`, hard gate on high-severity prod deps)     | Every PR + every push to `main` (`.github/workflows/ci.yml`)                       |
| Secret scanning (gitleaks)                                               | Every PR + every push to `main` (`.github/workflows/gitleaks.yml`)                 |
| Static analysis (semgrep)                                                | Every PR + every push to `main` (`.github/workflows/semgrep.yml`)                  |
| Dynamic scanning (OWASP ZAP baseline DAST against production storefront) | Nightly (`.github/workflows/zap-baseline.yml`, target `https://store.force-ai.co`) |
| Manual penetration-test pass (Burp checklist)                            | Quarterly — see run log in `docs/security/burp-manual-pentest-checklist.md`        |

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
- Audit trail: security-relevant actions logged (`audit_logs`), 90 days hot,
  then archived to R2 for 7 years.

## Incident response

- Documented plan: `docs/INCIDENT.md` — severity matrix (P0–P3) with response
  times, detection sources (uptime monitoring, Sentry, deploy-failure alerts),
  and a step-ordered P0 triage checklist. Shareable on request.
- Rollback procedures: `docs/ROLLBACK.md` + `scripts/rollback.sh`.
- Vulnerability reports: `security@force-ai.co` — policy in
  [`SECURITY.md`](../../SECURITY.md), machine-readable
  `/.well-known/security.txt` on all apps.

## Data residency

- Primary database: Neon Postgres, **AWS eu-central-1 (Frankfurt, Germany)**.
- Object storage: Cloudflare R2.
- CDN/edge: Cloudflare global network (sees encrypted traffic only).
- Kuwait Law 13/2023 (PDPL) does not require in-country residency for SaaS
  but does require erasure capability — provided (see Privacy below).

## Backups & disaster recovery

- Nightly encrypted off-machine database dump to a private R2 bucket
  (03:50 UTC, `.github/workflows/db-backup.yml`) — RPO ≤ 24h.
- Neon point-in-time recovery: **7 days** of history (restore to any second).
- Independent daily local dumps (9 rotations) as a third copy.
- Restore procedures documented and tested: `docs/ROLLBACK.md`.

## Privacy

- Record of processing activities / data map: `docs/privacy/data-map.md`
  (every PII category → where it lives, legal basis, retention, deletion path).
- Retention matrix: `docs/RETENTION.md`.
- Customer erasure: `POST /auth/me/erase` — irreversible PII anonymization,
  plus a monthly retention cron; third-party erasure propagated by event.
- Trackers are consent-gated (granular cookie-consent CMP); customer data is
  never fed to AI features.

## Evidence log

| Artifact                                    | Date       | Result                                                                                               |
| ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| ZAP baseline DAST — first activated run     | 2026-07-15 | 0 fail / 15 warn / 54 pass vs `https://store.force-ai.co` (run 29426193025); warns queued for triage |
| Manual Burp pass                            | —          | no recorded run yet; first scheduled pass Q3 2026                                                    |
| 13-dimension internal audit sweep           | 2026-07-02 | 0 critical / 0 high open (`docs/audits/2026-07-02-MASTER-deep-audit.md`)                             |
| Security-readiness (procurement lens) audit | 2026-07-15 | `docs/audits/2026-07-15-security-readiness-enterprise-procurement.md`                                |

Append a row per pentest/DAST/audit run — this table is the "can we see it?"
answer.
