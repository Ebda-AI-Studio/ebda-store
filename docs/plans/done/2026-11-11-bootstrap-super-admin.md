# 2026-11-11 - bootstrap ahmad@ebda.app as platform super-admin (Ruling ID-20)

**Goal:** the identity D1 has 0 super_admins; make `ahmad@ebda.app` one with no password or secret passing through an operator or agent, and alert if the count ever drops to 0 again.

**Finish line:** (1) `bootstrap-super-admin.mjs` creates a password-less, unverified super_admin + an audit row, mails the set-password code through the service, is idempotent, refuses a second admin without `--allow-additional`; (2) the enrolment token (ID-15) is issued only on the owner's TTY; (3) daily P1 when active or ready super_admins = 0; (4) tests prove each; (5) run once against production after merge + accounts deploy (migration 0006).

**Must not change:** ID-15's second-factor rules, `upsert-super-admin.mjs`, any merchant flow.

## Steps

1. `apps/accounts/migrations/0006_admin_audit.sql` - audit table.
2. `apps/accounts/scripts/bootstrap-super-admin-sql.mjs` (+ `.d.mts`) - pure plan/SQL helpers; `bootstrap-super-admin.mjs` - CLI.
3. `apps/accounts/src/data.ts` `superAdminSummary` + `Accounts.superAdminSummary()` RPC.
4. `apps/api/src/lib/super-admin-invariant.ts` + `CRON_SCHEDULE['0 3 * * *']` entry + `AccountsRpc` type.
5. Tests: `apps/accounts/test/bootstrap-super-admin.test.ts`, `tests/unit/super-admin-invariant.test.ts`.
6. Docs: Ruling ID-20, ID-15 cross-reference.

## Production run (after merge; accounts deploy applies 0006)

```
cd apps/accounts && CLOUDFLARE_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab node scripts/bootstrap-super-admin.mjs --email=ahmad@ebda.app --first-name=Ahmad --last-name=Sharaf --remote          # dry run
... --remote --apply
```

Then Ahmad: open the code e-mail -> store.ebda.app/reset-password -> set password -> in his own terminal `node scripts/bootstrap-super-admin.mjs --email=ahmad@ebda.app --remote --apply --issue-enrolment-token` -> sign in -> Account > Security -> request e-mailed code -> enrol TOTP or a passkey with token + code -> sign in again with the factor.
