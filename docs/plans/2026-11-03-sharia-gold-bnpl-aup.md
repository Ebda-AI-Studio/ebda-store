# Sharia decisions: gold prepaid, BNPL off by default, acceptable use (2026-11-03)

Source: `Ebda-AI-Studio/business/ebda/research/2026-11-03-sharia-compliance-check.md` (a research summary, not a fatwa). Rulings: SHARIA-GOLD-1, SHARIA-BNPL-1, SHARIA-AUP-1 (`docs/rulings/`).

Finish line. Works: a gold cart cannot be paid by COD or installments unless the store switched it on; installments are off for new stores and carry a disclosure; the AUP and merchant agreement ban the listed goods and practices in ar + en. Exercised: order create, admin order, `POST /payments/create`, `/payments/config`, the gold-rates admin page, the payment-settings card, the legal text. Must not change: carts without gold, card/wallet/InstaPay/Fawry on gold, any saved payment setting, the Ebda Chat terms. Done: touched tests green, typecheck of shared/api/web/admin clean, rulings indexed, merchant docs written.

## Design

1. Pure rule `checkGoldPayment` in `packages/shared/src/commerce/payment-policy.ts`; server wrapper `assertGoldPaymentAllowed` (`apps/api/src/services/gold-rate/payment-policy.ts`) called from `OrderService.create` (gold = `goldGate.snapshots.size > 0`), `createAdminOrder`, and `POST /payments/create` (gold = an order item has `goldSnapshot`). 409 `GOLD_PREPAID_ONLY`.
2. Setting: `store.settings.goldAllowDeferredPayment` (no migration; same pattern as `mcpWriteEnabled`). Server-owned key (`SERVER_OWNED_SETTINGS_KEYS`), written only by `PUT /stores/:id/gold-rates/payment-policy` (confirm required to turn ON, audit row). Admin card `GoldPaymentPolicyCard` on the gold-rates page.
3. Gateway pages for a gold order: Paymob drops the valU/Kiosk integrations, Kashier drops `bnpl` (`metadata.excludeBnpl`).
4. Storefront: `/payments/config` returns `goldPrepaidOnly`; checkout hides `cod`, `paymob:valu`, `paymob:kiosk` for a gold cart. Display only.
5. BNPL: defaults were already OFF in code (no integration id, Kashier default card+wallet). Added the disclosure (`BNPL_DISCLOSURE`) in the payment-settings card. No data change.
6. AUP: `legal-{ar,en}.ts` acceptableUse 2 and 3, merchant 5 and 7; `LEGAL_POLICIES` 1.2 for both; merchant docs.
7. No listing moderation exists, so none was built.

## Tasks (TDD)

1. Shared rule + tests (`packages/shared/src/__tests__/payment-policy.test.ts`).
2. Server enforcement + setting route + provider filters + tests (`tests/unit/gold-payment-policy.test.ts`).
3. Checkout hide + admin card + BNPL disclosure + tests (`tests/unit/bnpl-default-off.test.ts`).
4. Legal text and registry; rulings; merchant docs.
