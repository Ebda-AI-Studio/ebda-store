# Customer auth cutover (Postgres -> StoreDO)

NEON-ZERO-1 item N-9 (Ruling NZ-A3, NZ-N9-1..6 in `docs/plans/2026-11-02-neon-zero.md`). Run by the CONTROLLER; this repo holds no production credentials.
Scope: storefront CUSTOMERS (`users.role = 'customer'`, their refresh tokens, passkeys) of stores whose D1 `storage_backend` is `do`. Merchant / staff / admin auth is the identity service and is untouched.

## How the switch works

For a DO store the API serves customer auth from its StoreDO exactly when D1 `system_settings` has `customer_auth_cutover.<storeId>` (or the global `customer_auth_cutover.__all`). Deploying the code moves nothing. There is never a dual read. The DO tables are `_cauth_users`, `_cauth_refresh`, `_cauth_tokens`, `_cauth_passkeys`; the DO is the revocation authority (a revoke bumps `token_version` and revokes refresh rows in one section, then pushes the new version to the AuthState cache).

## Preconditions

1. Code deployed (`curl https://api.ebda.app/health` commit equals the tip of `main`; check every pipeline the merge triggered). The StoreDO creates its tables on start; no migration to run.
2. `CUTOVER_IMPORT_SECRET` set on the API Worker (>= 24 chars); `wrangler d1` access to `ebda-platform`.
3. Every store you pass is `storage_backend = 'do'` in D1 (the script refuses otherwise).
4. MFA check (Ruling NZ-N9-1): `SELECT id, email FROM users WHERE store_id = '<id>' AND role = 'customer' AND mfa_enabled AND mfa_secret IS NOT NULL;` should be empty. Any row cannot sign in on the DO until its MFA is cleared by hand.
5. Low traffic: customer registers / logins / refreshes of the store get a retryable 503 for roughly `2 x freeze-wait` (default 40 s).

## Steps

```
export CUTOVER_PG_URL=... CUTOVER_IMPORT_SECRET=...
F="--d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc --do-url https://api.ebda.app --allow-prod-read --store <uuid>"
node scripts/cf/cutover-customer-auth.mjs $F             # 1. DRY RUN: PG vs DO counts, marker state
node scripts/cf/cutover-customer-auth.mjs $F --commit    # 2. freeze -> wait -> copy -> read back + digest -> marker -> wait -> re-verify on a NEW connection -> DO live -> unfreeze
node scripts/cf/cutover-customer-auth.mjs $F --status
# after EVERY DO store is done (and for stores created later):
node scripts/cf/cutover-customer-auth.mjs $F --commit --global   # also writes customer_auth_cutover.__all
```

`--commit` refuses a store whose marker exists or whose DO says live. It flips only if EVERY table of the store is equal on both sides. Exit 2 = Postgres changed after the copy (drift): the DO is NOT marked live (imports stay open), the freeze stays; re-run is refused by the marker, so investigate, re-apply the rows by hand through `importRows`, then `--unfreeze`. Verification and reset links mailed before the flip stop working (Ruling NZ-N9-4).

## Verify after the flip (VERIFIED / NOT VERIFIED, both halves)

- `--status`: marker PRESENT, DO counts equal the dry-run PG counts.
- A seeded customer logs in on the storefront, `/auth/me` is 200, refresh rotates, "sign out everywhere" makes the very next request 401, a reset link works once, a second store's customer with the same email is a different account.
- NOT verifiable without a device: a passkey sign-in (unit-tested at the service and DO level only).
- Postgres `users` rows of the copied customers are STALE from now on (Ruling NZ-N9-6) and are removed with the Neon decommission.

## Rollback

Only before traffic: delete the marker row (`DELETE FROM system_settings WHERE key = 'customer_auth_cutover.<id>'`); isolates that saw it keep serving the DO until they recycle, and rows written to the DO since are not in Postgres. After traffic: forward-fix.
