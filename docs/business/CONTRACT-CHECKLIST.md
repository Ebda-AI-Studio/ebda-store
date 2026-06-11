# Force AI — Contract & Proposal Pre-Signing Checklist

> Run this before sending a new client proposal or signing a contract. The actual bilingual
> contract/quote templates live at `~/Desktop/work/Force AI/assets/` (4 HTML files: Force AI Store
> quote + contract, Force AI WhatsApp quote + contract) — they are NOT in this repo, so they don't
> auto-update when the product changes. This checklist closes that gap. Last reviewed: **2026-06-01**.

## Every claim in a contract/quote must be true against the codebase

- [ ] **Plan → feature mapping** matches `docs/business/plan-feature-matrix.md` (which is derived from `packages/shared/src/plan-baselines.ts`). Common drift points:
  - loyalty / push_notifications / upsell_crosssell are **Professional**, not standalone add-ons.
  - affiliate / sms / floating_widget are **Enterprise**.
  - accounting basic/expenses/invoicing = **Professional**; advanced accounting (tax_reports, multi_currency, profit_anomaly, bank_reconcile) = **Enterprise**.
  - inventory.basic = **Starter**; stock_alerts + backorder = **Professional**; multi_warehouse/barcode/purchase_orders/bulk_adjustments = **Enterprise**.
- [ ] **No self-serve / free-trial language.** Force AI Store is managed-agency, one-time **yearly** fee, no monthly subscription. (`free` is a grace state, not a sold tier.)
- [ ] **New features represented** if the quote enumerates capabilities: product discount engine, accounting module (CoA + journals + P&L), reorder/dead-stock AI, page-builder consolidation.
- [ ] **WhatsApp product** describes the **native Meta catalog** bot flow (browse catalog → select → quantity → checkout link). The old "send an image per category" flow was removed — must not appear.
- [ ] **WhatsApp ↔ Store dependency**: the WhatsApp ordering bot requires an active linked Force AI Store — keep that wording if present.

## Terms that were verified accurate (don't change without a reason)

- [ ] **SLA**: 99.5% monthly uptime, 24h normal / 4h critical support response, credit = 1 service-day per excess downtime hour (cap 30 days/year). Defensible against current infra (Neon + Railway + Vercel + Redis + Inngest).
- [ ] **Data protection**: Kuwait Law 13/2023 Data-Processor split; erasure (`/auth/me/erase`) + export (`/auth/me/export`) endpoints exist; ≥30-day backups. (See `docs/RETENTION.md`.)
- [ ] **Third-party cost carve-outs**: payment-gateway commissions, shipping-carrier fees, domain registration are the client's cost, not Force AI's.
- [ ] **Payment**: bank transfer / KNET / cheque payable to شركة فورس AI.

## Bundle (Force AI Store + Force AI WhatsApp)

- [ ] A client buying both gets two quotes / two contracts today (no master agreement template exists). Send the two quotes side-by-side; co-sign both, or note a master agreement is a future option.

## After product changes

When a feature's plan tier changes, a new feature ships, or pricing changes:

1. Update `packages/shared/src/plan-baselines.ts` (code — source of truth).
2. Regenerate `docs/business/plan-feature-matrix.md`.
3. Update `docs/business/04-pricing-tiers.md`, `02-feature-catalog.md`, `06-faq.md`.
4. Update the 4 HTML templates at `~/Desktop/work/Force AI/assets/`.
5. Re-run this checklist before the next signing.
