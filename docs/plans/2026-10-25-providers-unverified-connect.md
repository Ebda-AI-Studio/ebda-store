# Providers: connect unverified providers, check on save, learn from the first merchant

Ruling PROVIDERS-3 (Ahmad 2026-10-24): no provider test accounts. The first merchant's own credentials are the verification. Marketing keeps all 10 providers (no «قريباً»).

Finish line

- Must work: any catalog provider connects and enables once its check passes; save runs the check automatically; first real use of an unverified provider pages ops; N real successes flip it verified (evidence stored, visible to super admin).
- Exercised: PUT credentials (payments + carriers) returns `check`; enable gate; first create-payment / create-shipment; admin verification list.
- Must NOT change: verified providers' behaviour, secrets never logged/returned, COD/InstaPay/manual untouched, tenant scoping.
- Done: touched unit tests green, typecheck + lint on touched packages, Opus review, merged, /health commit == main tip.

Design

1. Gate (`provider-gate.ts`): `isProviderUsable` = any catalog provider. The enable gate keeps the real protection: a passing Test connection for exactly the stored credentials (fingerprint). The runtime offer needs only catalog membership: the enable gate plus 'a credential edit disables the row' are the single guard (Ruling PROVIDERS-3c; a runtime test-current check broke every unit suite that seeds an enabled unverified row, and no pre-launch merchant has a legacy row). The per-store activation request stays in the code base but no longer gates; its UI panel is replaced by an "unverified" notice.
2. Check on save: credentials PUT (payments, carriers) runs the adapter's read-only/auth call for the SAVED mode (sandbox first), stores `connection_test`, returns `check = {status: connected|credentials_wrong|unreachable|unrecognized|unverified, ok, code, messageEn, messageAr}`. Provider without a check call -> `no_check` (ok, `unverified`, warning). Pure mapper in `@ebda/shared`.
3. Evidence + first use: new GLOBAL tables `provider_verifications` (per provider counters, `verified_at`) and `provider_verification_events` (append-only, capped, no secrets: store, op, ok, ref, error code). `recordProviderOperation()` is called at the two real choke points (create payment through the breaker, paid confirmation; carrier createShipment). First event for (provider, store) while unverified -> P1 store alert (store, provider, op, outcome). Failures while unverified also alert (throttled by the alert service). `PROVIDER_AUTO_VERIFY_AFTER` (default 3) successes -> `verified_at` set, info alert.
4. `isProviderVerified(code)` = catalog.verified OR verified_at (60 s in-process cache, BOUNDED-stale: only drives bookkeeping + display, never a money gate).
5. Super admin: `GET /admin/provider-verification` + section on the provider-activation page.
6. Docs + help guides ar/en.

Ruling PROVIDERS-3b - success = payment invoice accepted or paid-confirmed, shipment booked; N=3. Cost if wrong: a provider shows verified after 3 easy successes while an edge flow (refund, webhook variant) is still broken; first-use alerts keep firing for failures only while unverified, so verified-too-early would silence them.

Ruling PROVIDERS-3c - runtime offer = catalog membership; the enable gate is the only guard. Cost if wrong: an enabled row that bypassed the settings routes is offered without a passing test; pre-launch there are no such rows.
