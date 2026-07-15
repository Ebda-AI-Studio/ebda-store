# Security-Readiness Audit — Enterprise Procurement Lens (2026-07-15)

**Source:** Instagram reel DayW9qUEVyF ("the security questionnaire kills the deal
before the demo"). Distilled thesis: enterprise/serious buyers send a security
questionnaire before any contract; builders who can answer it (encryption, vuln
scanning, pentest evidence, incident-response plan, data residency) — and who
publish a security page + vulnerability-reporting channel — close deals; the
rest get silence.

**Lens (checkable terms):**

1. Encryption at rest + in transit — implemented AND documented in one shareable place?
2. Vulnerability scanning — running (not just configured) with a stated cadence?
3. Pentest / DAST — any evidence artifact? cadence documented?
4. Incident-response plan — exists, current, shareable?
5. Data residency — answerable with a region, not a shrug?
6. Public security page / trust surface?
7. Vulnerability-disclosure channel — SECURITY.md + RFC 9116 `/.well-known/security.txt`?
8. Audit scorecard — consolidated doc a buyer can be handed?

**Scope:** force-website-builder @ `0c698556` (origin/main). Read-only audit from
the root checkout; fixes on branch `fix/security-readiness-lens`.

## Verdict

Internal security posture is strong (13+ dated audits, gitleaks + semgrep + npm-audit
gates, ZAP workflow, data-map/RETENTION/erasure endpoints, INCIDENT.md). The gap is
exactly the reel's thesis: almost none of it is packaged for a buyer. The facts
exist; the artifacts a procurement team asks for don't.

## Tally: 0 Critical · 3 High · 2 Medium · 1 Low

### HIGH

**H1 — No vulnerability-disclosure channel.** No `SECURITY.md` anywhere in the repo;
no `/.well-known/security.txt` served by any of the three Next.js apps (web, admin,
orders — all have `public/` dirs, none has the file). Questionnaire line "how do we
report a vulnerability to you?" is unanswerable.
_Fix:_ root `SECURITY.md` (disclosure policy, scope, response SLO) +
`public/.well-known/security.txt` (RFC 9116: Contact, Expires, Policy) in all three
apps. Contact `security@force-ai.co` — verified deliverable today via the zone's
catch-all Email Routing rule → forceai.0ps1@gmail.com.

**H2 — DAST has never run.** `.github/workflows/zap-baseline.yml` (nightly ZAP
baseline) has been dormant since creation: it exits unless the `ZAP_TARGET` repo
variable is set, and it never was (`gh variable list` → absent). Zero DAST evidence
exists despite the pipeline being built.
_Fix:_ set `ZAP_TARGET=https://store.force-ai.co` (baseline scan is passive —
safe against production) + dispatch one run to produce the first artifact.

**H3 — No buyer-shareable security overview.** The answers to the standard
questionnaire are scattered across `docs/privacy/data-map.md`, `docs/RETENTION.md`,
`docs/business/06-faq.md`, `docs/business/cyber-liability-insurance-brief.md`, and
dated audits. Nothing consolidated to hand a buyer ("answers half the questionnaire
before they send it").
_Fix:_ `docs/security/security-overview.md` — grep-derived (not aspirational)
one-pager: encryption at rest (Neon `fwb-eu` AES-256 @ aws-eu-central-1 Frankfurt;
R2), in transit (TLS via Cloudflare, HSTS at API `apps/api/src/middleware/security.ts`),
scanning cadence (gitleaks + semgrep + npm audit per-PR, ZAP nightly), IR plan pointer,
residency, backups/DR, erasure + export endpoints, disclosure channel.

### MEDIUM

**M1 — IR plan is stale (defect class: cancelled-platform references).** A buyer
asking "can we see your incident-response plan?" gets `docs/INCIDENT.md` naming
**Vercel** as a live detection source and rollback path — the platform was cancelled
2026-07; hosting is Cloudflare Workers (via `cf-deploy.yml`) + Railway. Class sweep
across living docs: `docs/runbooks/STAGING-DEPLOYMENT.md` and
`docs/runbooks/orders-pwa-deploy.md` already carry explicit SUPERSEDED banners
(historical by design — clean); `docs/ROLLBACK.md`'s single mention is a correct
"unlike Vercel" comparison (clean). Only INCIDENT.md was genuinely stale.
_Fix:_ replace INCIDENT.md's two Vercel entries with the CF Workers reality
(`cf-deploy` failure detection + `wrangler rollback`).

**M2 — Pentest cadence and evidence log missing.**
`docs/security/burp-manual-pentest-checklist.md` has no "last run" record and no
cadence commitment; ZAP runs (once H2 lands) leave no doc trail either.
_Fix:_ evidence-log + cadence section in the security overview and a log header in
the burp checklist.

### LOW

**L1 — No public /security page on the marketing site.** `apps/web` is the tenant
storefront runtime; the platform marketing site is force-ai.co (**repo
force-ai-landing — out of this audit's scope**, which Ahmad set to fwb). Flagged
cross-repo; the lens is registered in the Builder Reality Audit fleet and will catch
it when run against force-ai-landing. The security-overview doc (H3) is written so
its content can be lifted onto that page directly.

## Already-passing lens items (for the record)

- Encryption at rest/in transit: implemented (Neon, R2, CF TLS, API HSTS) — the gap
  was documentation only.
- Vuln scanning pipelines: gitleaks.yml, semgrep.yml, CI npm-audit gate — active.
- Erasure/export: `/auth/me/erase` + data-map + RETENTION — strong PDPL/GDPR story.
- Prior 2026-07-02 security-surface audit: 0 critical / 0 high open.
