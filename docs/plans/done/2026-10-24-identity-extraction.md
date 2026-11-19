# Shared identity service: extraction plan (Rulings ID-1, ID-2, ID-3)

Contract (binding, owned by the Store session): `business/ebda/plans/2026-10-24-ebda-identity-token-contract.md` v1. This plan is how the Store side meets it. Order from Ahmad: identity first, before skin deletion and Phase 1 of the Cloudflare migration.

## Finish line

- **Must work:** a merchant signs up, verifies, logs in (password, TOTP, passkey), refreshes, logs out and revokes; the admin app (store.ebda.app) runs on an ES256 token from `accounts.ebda.app` with `aud=store` and `stores[]`; a stub second product accepts the same login; logout on either kills both.
- **Exercised by:** `apps/accounts` workerd tests (29 incl. a software WebAuthn authenticator, forgery, CSRF, reuse detection), the Store verification tests, and a live login / passkey / logout on the real admin host.
- **Must NOT change:** customers (storefront accounts, `users.store_id` set) keep their HS256 store-internal login (Ruling ID-3); public URLs and API contracts; money paths.
- **Done =** the above verified against production, with what could not be verified listed.

## Architecture

| Concern    | Decision                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker     | `ebda-accounts` at `accounts.ebda.app`, D1 `ebda-identity` (id in `apps/accounts/wrangler.jsonc`), secrets via `wrangler secret`: `JWT_PRIVATE_JWK`, `MFA_KEY`. No preview environment (INFRA-PREVIEW-1).                                                                |
| Tokens     | ES256 `at+jwt`, `kid`, `iss=https://accounts.ebda.app`, `aud` one of store/whatsapp/crm/erp, `sub`, `sid`, `stores[]`, `pa`, 15 min, `jti`. Additive v1 claims `email`, `email_verified` (proposed to the contract owners; products without a user table need them).     |
| Session    | Opaque refresh cookie `__Host-ebda_rt` (host-only, Secure, HttpOnly, SameSite=Lax) on `accounts.ebda.app`; stored as sha256; sliding 30 days; rotated at most every 24 h with a 60 s grace for parallel tabs; reuse outside the grace revokes the session (Ruling ID-4). |
| Revocation | Per-session (`sid`). Products call `Accounts.isRevoked(sid)` over a Service Binding on every authenticated request (not only sensitive ones): logout is immediate, not "15 minutes later" (Ruling ID-6).                                                                 |
| `stores[]` | Computed at token time by the Store over a Service Binding (`StoreDirectory.storesForUser`): no second membership table to keep in step; a failed read is a 503, never an empty claim. Phase 2 swaps the source to the D1 directory.                                     |
| Mail       | Accounts calls the Store's platform mailer over a Service Binding (`IdentityMailer.sendCode`); the 6 digit code rides inside the existing branded link, so no new template.                                                                                              |
| Passkeys   | Ceremony origin allow-list, `rpId` = that origin's hostname (what the Store stored), so existing admin passkeys keep verifying; the login page therefore stays on the admin origin and calls accounts.                                                                   |
| Customers  | Not migrated (Ruling ID-3).                                                                                                                                                                                                                                              |

## Rulings

- Ruling ID-4 - refresh tokens are opaque, hashed, rotated daily with reuse detection; `GET /token` is read-only except for that daily rotation. Cost if wrong: a stolen cookie is only detected at its next rotation or reuse; bounded by the 30 day sliding window and per-session revocation.
- Ruling ID-5 - merchants re-login once at cutover. Evidence: the refresh cookie moves from api.ebda.app to accounts.ebda.app; browsers cannot transfer it; production has 6 admin users and 12 refresh tokens. Legacy refresh rows are copied (byte-for-byte) but never matched. Cost if wrong: one extra login per merchant.
- Ruling ID-6 - the Store checks `Accounts.isRevoked(sid)` on every authenticated admin request. Evidence: Service Binding calls are same-datacentre and a revocation that waits for token expiry is not revocation. Cost if wrong: one extra sub-request per admin call; drop to sensitive-only by changing one function if latency matters.
- Ruling ID-7 - failed-login throttle lives in D1 (5 per email and 30 per IP per 15 minutes), not a Durable Object. Evidence: identity volume is tiny and D1 keeps the Worker on one storage system. Cost if wrong: contention at high attack volume; a DO is the drop-in upgrade.
- Residuals (documented, not hidden): TOTP codes can be replayed inside their 90 s window; email lock is per address (an attacker can lock a victim's password login, not their passkey login); `email` and `email_verified` claims are not in contract v1 until the owners accept them.

## Security review (Opus, 2026-10-24) and parity with the Store's current login

Findings fixed in stage 1, each with a regression test (`apps/accounts/test/hardening.test.ts`, `review2.test.ts`): pre-hijacking (login/passkey/MFA refused until the email is verified; the signup password is bound to its own code and never written to the user row, Ruling ID-10; purge on first verification), MFA brute force (guarded atomic attempt counter, one live challenge per user, count-first per-user budget a new challenge does not reset; every TOTP-checking endpoint goes through one throttled check), login CSRF (origin guard and JSON-only on every state-changing request), TOTP replay (single-use step), parallel brute force of the password (count-first throttle), audience confusion (credential management accepts only `store` tokens; no `issue` RPC), step-up throttling, passkey registration needing a second factor when MFA is on, unauthenticated flooding (per-IP budgets, challenge cleanup), backup-code double spend, OTP send-cap race, absolute session lifetime, code in the URL fragment, marketing origin removed from the allow-list.
Parity with today's Store login (all verified against `apps/api`): the Store lets an unverified account sign in (accounts: refused), counts MFA attempts per challenge only (accounts: per user), exempts the credential-less auth entry points from CSRF (accounts: origin guard on all), and accepts a replayed TOTP code inside its window (accounts: single use). The identity service is therefore stronger on each of the four points, not weaker.
Residuals accepted and written down: Service Binding RPC (`createUser`, `revokeUser`, `StoreDirectory`, `IdentityMailer`) trusts any Worker in the same Cloudflare account that holds the binding; the personal account also hosts unrelated Workers (recommendation to Ahmad: move `ebda-accounts` and `ebda-api` to an Ebda-only account when the entity exists); email lock per address means an attacker can lock password login for a victim (passkey login stays available).

## Stages (each merged on green, verified)

1. `apps/accounts` + Store RPC entrypoints (`StoreDirectory`, `IdentityMailer`) + CI/deploy wiring. Deploy order: ebda-api first (entrypoints must exist), then accounts.
2. Data migration script (read-only Postgres, writes D1, row-count and checksum asserts) and run against production.
3. Store verifies ES256 via JWKS (`aud=store`, `stores[]`, revocation) next to HS256 customers; admin app and orders PWA sign in through accounts; signup provisioning calls `Accounts.createUser`.
4. SSO tests with a stub second product; Opus security review; live verification on the real admin host.
5. Contract phase: stop issuing HS256 tokens for the admin namespace after a soak (separate PR, after Ahmad's go).
