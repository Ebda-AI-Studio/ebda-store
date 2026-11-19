# Grant a plan on the platform D1 (no payment)

`scripts/ops/grant-plan-d1.mjs` puts a store on a paid plan for one period WITHOUT a money row. Use it for internal or
owner-family stores that must stay out of the financial records. If money was actually received, use super-admin Billing
"Record manual payment & activate" instead (it writes the ledger row).

Why a script: `runCompMigration` and `assignPlan` read through Prisma, which throws `POSTGRES_REMOVED` since the Neon
removal; the platform data is in D1 `ebda-platform`.

```
CLOUDFLARE_ACCOUNT_ID=<personal acct> PLATFORM_DB_ID=<ebda-platform uuid> \
  node scripts/ops/grant-plan-d1.mjs --store-id <uuid> --plan business --interval yearly --reason "<why>"   # dry run
  ... --apply --confirm <uuid>                                                                              # writes
```

- Dry run is the default and prints the decision and what would change. `--apply` needs `--confirm` equal to the store id.
- Decisions: `grant`, `noop` (already on that plan/interval, active, nothing pending), `refuse` (missing/deleted store,
  unknown plan, no subscription, active instapay store with paid history).
- Writes on apply, in order: `store_subscriptions` (compare-and-set on `updated_at`; plan, `active`, interval, period now
  to +1 interval, `instapay`; `pending_plan_code`, `trial_ends_at`, dunning cleared), `stores.plan` = the plan's feature
  tier, one `platform_audit_log` row `billing.plan_granted_no_payment` (with `--reason`). Statements 2 and 3 only write
  if statement 1 landed. No `billing_events` row, no amount, no VAT.
- Cache residual (BOUNDED-stale, not busted by the script): the feature cache expires within 5 minutes (CACHE_TTL 300 s)
  and the store payload / directory caches on their own TTLs. For an immediate bust, re-save the store in super-admin.
- After the period ends the store follows the normal InstaPay path (reminders, due day, grace, suspension).
- Rollback: restore the previous values printed under `decision.from` with a manual `UPDATE store_subscriptions`.
