# SP6 — Payments layer (task plan, 2026-10-04)

Budget $40. Sonnet adapters; Opus money review in the PR. No real-money transaction without Ahmad's explicit OK. Inputs: `docs/ebda/research/egypt-payment-providers.md`, `docs/ebda/plans/sp4-kwd-residuals.md` (provider KWD spots), the existing FWB provider factory (`apps/api/src/services/payment.factory.ts`, `payment-providers/*`).

| # | Task | Notes |
|---|---|---|
| 6a | `PaymentProvider` interface v2 + shared contract suite; COD; **InstaPay manual confirm** (Review Focus 3): awaiting-confirmation orders don't ship, don't count as paid revenue, expire, and can't be confirmed twice; per-merchant encrypted credentials; sandbox flag per adapter; outage isolation (one failing provider disables one method, checkout still works) | Opus money review |
| 6b | Adapters against local stubs + contract suite: Paymob (cards, Meeza, wallets, valU via Paymob) → Kashier → Fawry (reference code); remove Kuwait providers (Tap, MyFatoorah, Hesabe, UPayments, KNET labels) and move the parity harness stub to Paymob | Opus money review |
| 6c | Sandbox runs with real sandbox keys (when Ahmad provides them) | blocked on keys |
