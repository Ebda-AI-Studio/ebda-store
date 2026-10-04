# Ebda — status (updated 2026-10-04)

Spend is an ESTIMATE from sub-agent token counts (the cloud session exposes no dollar meter). All SPs are inside their allocation so far.

| SP | State | Evidence / PRs | Est. spend |
|---|---|---|---|
| SP10 research | **done** | `docs/ebda/research/` (4 briefs). [Whisky-11/ebda#1](https://github.com/Whisky-11/ebda/pull/1) | ~$4 |
| SP3 design + spike | **done** (gate taken under "do not stop", R-EBDA-001) | `docs/ebda/design/`, `spikes/workers-api/` (17/17 on workerd, 0 leaks, mutation-checked) | ~$12 |
| SP4 clone + rebrand | **in progress** (tasks 0–5, 7, 8 merged; 6 Worker shell + 9 lean CI running) | [Whisky-11/ebda#2](https://github.com/Whisky-11/ebda/pull/2) | ~$30 |
| SP5 self-serve + billing | **mostly done** (tasks 1–4 merged; 5 unaided E2E + timed run pending) | same PR (stacked on SP4) | ~$20 |
| SP6 payments | not started | — | $0 |
| SP7 shipping | not started | — | $0 |
| SP8 WhatsApp free tier | **done** | wa.me helper, PDP/thank-you/tracking buttons, order email, admin; no API calls (tested) | ~$2 |
| SP9 site/docs/help/status | **done (build + gates)**; deploy waits on credentials | `apps/marketing`, `apps/docs`, `apps/help`, `apps/status` — axe 0 serious; status incident test green on workerd | ~$5 |

## Verified on the integration branch (`claude/ebda-sp4` @ 4215b444)
- Unit: 468 files, 6,099 passed, 0 failed. Typecheck clean.
- Full suite including integration + e2e with the API as `ebda_app` (strict RLS), on the DB branch before the final merges: 7,931 tests, 0 failures.

## Ahmad — decisions / inputs needed
1. **Prices** per plan, free-tier caps, platform fee bps (engine ships with placeholders; paid checkout refuses null prices).
2. **Amelia Aurum catalogue export** (CSV; Shopify format works). Egress policy blocks ameliaaurum.com from the cloud session.
3. **Credentials** (none needed to keep building): Cloudflare token + Neon project (deploy, real Hyperdrive proof), Kashier sandbox + written recurring enablement, Resend key + verified `ebda.app` sender, then Paymob/Fawry/Bosta/Aramex sandboxes.
4. **GitHub:** enable Actions on `whisky-11/ebda` and set the default branch to `main` (no workflow is registered today, so PRs show no checks).
5. **Review R-EBDA-001** (Express on Workers, Containers as fallback) and **R-EBDA-002** (strict RLS; `stores` table RLS is an accepted residual with a follow-up plan: `docs/ebda/plans/sp4-stores-rls-followup.md`).
6. Tax: new stores get an active 14% VAT rate but `taxEnabled=false` (inherited ruling TAX-1). Enable by default?
7. Legal pages (`/legal`, `/privacy`, `/terms`) are DRAFT placeholders for counsel.

## Notable findings fixed along the way
- Custom-domain hijack of Ebda hosts (`rival.ebda.app` as a "custom domain") — blocked; unverified domains are never served (pending → verified, 72h release).
- Login lockout bypass by re-casing the email — fixed.
- Mutating SECURITY DEFINER functions without caller checks — guarded (42501).
- FWB bulk import failed on new categories (one outer tx) — fixed.
- Prisma driver-adapter error shapes broke P2002 handling and deadlock retry — fixed.
- site-kit source hidden by the global `build/` ignore — fixed.
