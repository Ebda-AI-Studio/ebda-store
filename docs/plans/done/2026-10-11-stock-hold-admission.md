# Stock-hold admission correction

Goal: concurrent COD/InstaPay order creation cannot exceed the identity/IP hold thresholds; an uncapped gateway order cannot acquire an indefinite manual-payment hold; full-wallet orders remain exempt.

## Verified constraints

Order.paymentMethod is an input, not a persisted column. Storefront checkout submits the same provider in both creation steps; retry creates a fresh order. Existing payment routes deliberately allow switching. The current cap runs before the order transaction and before wallet coverage. Original PR65 already adds checkout_ip and partial count indexes in an unapplied migration.

## Implementation

1. Add a server-owned manualHoldAdmitted boolean (default false) to the same unapplied PR65 migration and Prisma model. Only OrderService sets it on a newly admitted unpaid manual order. Existing manual-payment rows support same-provider retries; an older order without admission or a prior manual payment must use a fresh checkout. Do not infer admission from a zero COD fee.
2. Acquire transaction-scoped PostgreSQL advisory locks for the tenant's canonical phone, email and IP, sorted to avoid conflicting lock order. Count after acquiring locks and before inventory writes/order insertion in the same money transaction. Skip admission for a fully wallet-paid order; a failed authoritative wallet debit rolls the transaction back.
3. Normalize new email storage and admission keys; compare/index lower(trim(legacy email)) so email casing cannot bypass either counting or lock serialization. Preserve tenant filtering and server-observed normalized IP.
4. Require admission for new COD/InstaPay attachment. Preserve same-provider idempotent responses and existing COD-fee checks. Gateway-to-manual conversion is intentionally refused; other gateway switching remains as before.
5. Correct threshold docs: phone/email default2, IP default8 or configured OPEN_UNPAID_HOLD_IP_CAP, applied even when contact identity exists. Repair the CGNAT regression to prove eight distinct identities share an IP and the ninth is refused.

## Verification

Start with failing concurrency, payment-switch, full/partial wallet and CGNAT regressions. Run unit plus real local-Postgres integration tests under the app role for touched paths; verify transaction rollback leaves inventory and wallet balances intact. Check tenant isolation and lock ordering, run normal local gates, independent review, exact-head CI and required runtime checks. Sweep admission field consumers, payment entry points, identity storage/index expressions, expiry/cancellation, configuration and docs. Production migration/deployment requires separate authorization if the saved handoff's no-production-schema rule applies; prepare the exact migration and evidence before that approval step.
