# Ebda — status (updated 2026-10-04, all sub-projects built; remaining items need Ahmad)

Spend is an ESTIMATE from sub-agent token counts (the cloud session exposes no dollar meter). All SPs are inside their allocation so far.

| SP | State | Evidence / PRs | Est. spend |
|---|---|---|---|
| SP10 research | **done** | `docs/ebda/research/` (4 briefs). [Whisky-11/ebda#1](https://github.com/Whisky-11/ebda/pull/1) | ~$4 |
| SP3 design + spike | **done** (gate taken under "do not stop", R-EBDA-001) | `docs/ebda/design/`, `spikes/workers-api/` | ~$12 |
| SP4 clone + rebrand | **done** (deploy waits on CF token + Neon) | [Whisky-11/ebda#2](https://github.com/Whisky-11/ebda/pull/2); `docs/ebda/plans/sp4-sp5-evidence.md`: parity Node vs Workers **as `ebda_app`** 16/16 with real payment traffic; Amelia catalogue served at `amelia.ebda.app` by the Worker; no-FWB-branding green; Stage 2 bursts + 1,000-request soak 0 errors / 0 leaks | ~$45 |
| SP5 self-serve + billing | **done** except the human timed run (needs Ahmad) | unaided E2E signup → store → product → COD order passes on Workers and Node (~2 s of work, 5 s wall incl. anti-bot wait) | ~$25 |
| SP6 payments | **done against stubs**; 6c (real sandboxes) waits on keys | PaymentProviderV2 + contract suite; COD; InstaPay manual confirm (R-EBDA-003); Paymob, Kashier, Fawry adapters; Kuwait providers removed | ~$20 |
| SP7 shipping | **done against stubs**; sandboxes wait on keys | ShippingCarrier contract suite; Bosta, Aramex (COD gated until EGP confirmed), manual; COD reconciliation to the piastre (R-EBDA-004) | ~$8 |
| SP8 WhatsApp free tier | **done** | wa.me only, no API calls (tested) | ~$2 |
| SP9 site/docs/help/status | **done (build + gates)**; deploy waits on credentials | `apps/marketing`, `apps/docs`, `apps/help`, `apps/status` | ~$6 |

Spend is a rough estimate from token counts (no dollar meter in the cloud session); total ≈ $120 of $235, no SP more than 50% over its allocation except SP4 (~$45 vs $40, +13%), driven by the Workers port.

## Verified on the integration branch (`claude/ebda-sp4`, after the SP7 merge)
- Unit: 489 files, 6,736 passed, 0 failed. Typecheck clean.
- Full suite including integration + e2e with the API as `ebda_app` (strict RLS), on the DB branch before the final merges: 7,931 tests, 0 failures.

## Ahmad — decisions / inputs needed
1. **Prices** per plan, free-tier caps, platform fee bps (engine ships with placeholders; paid checkout refuses null prices).
2. **Amelia Aurum catalogue export** (CSV; Shopify format works). Egress policy blocks ameliaaurum.com from the cloud session.
3. **Credentials** (none needed to keep building): Cloudflare token + Neon project (deploy, real Hyperdrive proof), Kashier sandbox + written recurring enablement, Resend key + verified `ebda.app` sender, then Paymob/Fawry/Bosta/Aramex sandboxes.
4. **GitHub:** enable Actions on `whisky-11/ebda` and set the default branch to `main` (no workflow is registered today, so PRs show no checks).
5. **Review R-EBDA-001** (Express on Workers, Containers as fallback) and **R-EBDA-002** (strict RLS; `stores` table RLS is an accepted residual with a follow-up plan: `docs/ebda/plans/sp4-stores-rls-followup.md`).
6. Tax: new stores get an active 14% VAT rate but `taxEnabled=false` (inherited ruling TAX-1). Enable by default?
7. **Timed manual run** of self-serve onboarding (<10 min target): the exact clicks are in `docs/ebda/plans/sp4-sp5-evidence.md`.
8. **CI trade-off** (`docs/ebda/ci.md`): to fit 2,000 min/month, PRs run lint/typecheck/unit on changed paths; RLS proof nightly; integration + e2e + mutation weekly (Sunday) — an integration regression can surface up to a week after merge. Approve, or raise the budget.
9. Carrier/gateway facts to confirm in writing: Aramex domestic COD in EGP; Kashier recurring enablement; Bosta governorate→city map.
10. Legal pages (`/legal`, `/privacy`, `/terms`) are DRAFT placeholders for counsel.

## Notable findings fixed along the way
- Custom-domain hijack of Ebda hosts (`rival.ebda.app` as a "custom domain") — blocked; unverified domains are never served (pending → verified, 72h release).
- Login lockout bypass by re-casing the email — fixed.
- Mutating SECURITY DEFINER functions without caller checks — guarded (42501).
- FWB bulk import failed on new categories (one outer tx) — fixed.
- Prisma driver-adapter error shapes broke P2002 handling and deadlock retry — fixed.
- site-kit source hidden by the global `build/` ignore — fixed.
- Buy-flow parity was passing vacuously (payment endpoints 404 on both sides under strict RLS) — fixed; the harness now fails on payment 404s.
- Shipping settings/routes empty under strict RLS — fixed; Aramex COD was sent as KWD (/1000) — fixed and gated.
- Secret leak in public `/payments/methods` — fixed.
- Known gap: unknown/rival store host on the public product API answers 400 `STORE_NOT_RESOLVED` (no data) rather than 404.
