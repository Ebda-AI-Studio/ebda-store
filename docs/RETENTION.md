# Data retention policy

How long every PII or PII-adjacent column lives, and what enforces it.
Companion document to:

- `~/.claude/CLAUDE.md` § Production Reality gates rule 9 (GDPR erasure).
- `docs/superpowers/plans/2026-05-13-iceberg-audit-v2.md` § Tier 1 item #16
  and Tier 3 item #15.
- `docs/privacy/data-map.md` — the third-party-destination companion to
  this table (PostHog / OneSignal / pixels & CAPI / Sentry / Resend / R2 /
  backups), plus the erasure-propagation and backup-boundary writeups.

The policy reconciles two opposing legal pressures on FWB:

- **Kuwait Personal Data Protection Law 13/2023 Art. 17** + **GDPR
  Art. 5(1)(e)** ("storage limitation"): keep PII no longer than the
  business need it was collected for.
- **Kuwait MOF (tax authority)**: keep invoice records for ≥5 years.

The rule is: financial records survive at the table level, but the PII
attached to them gets stripped on schedule.

## Per-table matrix

| Table                                            | PII / sensitive fields                                                                                                           | Retention                                                                       | Mechanism                                                                     | Legal basis                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `users` (active)                                 | email, firstName, lastName, phone, dateOfBirth, avatar, passwordHash                                                             | Active account lifetime                                                         | None — service delivery requires it                                           | GDPR Art. 6(1)(b) contract                                  |
| `users` (soft-deleted, `deletedAt` set)          | same as above                                                                                                                    | 12 months past `deletedAt`, then anonymize via `eraseAccount`                   | `soft-deleted-user-anonymize` Inngest cron, 1st of month 02:00 UTC            | Kuwait Law 13/2023 Art. 17 storage limitation               |
| `users` (erased via `/auth/me/erase` or cron)    | email rewritten to `erased-<uuid>@anonymized.local`, names = "Erased User", phone/avatar/dateOfBirth NULL, passwordHash = random | Indefinite (no PII left to retain)                                              | Manual erase endpoint OR retention cron                                       | GDPR Art. 17 right to erasure                               |
| `addresses`                                      | firstName, lastName, phone, full address                                                                                         | Until user deletes OR account is erased                                         | Immediate on `eraseAccount` (hard delete)                                     | Service delivery only                                       |
| `orders` (`customerId` set)                      | `customerId` FK + shippingAddress / billingAddress JSON snapshots, customerNotes                                                 | Until account is erased; then 5 years anonymized                                | `eraseAccount` nullifies `customerId` + scrubs JSON; row retained 5y for MOF  | Kuwait MOF tax retention                                    |
| `orders` (anonymized)                            | none — `customerId=null`, addresses = `{anonymized:true}`                                                                        | 5 years from order date, then deletable                                         | Manual ops review (no cron yet — see "Future work" below)                     | Kuwait MOF tax retention                                    |
| `order_items`                                    | productName, variantName, sku, price                                                                                             | Same as parent order                                                            | Cascades from `orders`                                                        | Same                                                        |
| `payments`                                       | provider, method, amount, providerTransactionId, idempotencyKey                                                                  | Same as parent order                                                            | Cascades from `orders`                                                        | Kuwait MOF + payment-provider reconciliation                |
| `reviews`                                        | `customerId` FK; body, title, rating                                                                                             | `customerId` nulled on `eraseAccount`; body retained anonymously                | Manual erase only                                                             | Public content integrity (anonymous review is valid)        |
| `returns`                                        | `customerId` FK; reason, items                                                                                                   | `customerId` nulled on `eraseAccount`; row retained for warranty/refund history | Cascades from order                                                           | Consumer-protection regs                                    |
| `abandoned_carts` (with `customerId`)            | `customerId`, customerEmail, customerPhone, cartItems JSON                                                                       | Until account is erased                                                         | Cascades on `eraseAccount` (hard delete)                                      | Recovery email scope                                        |
| `abandoned_carts` (anonymous, `customerId` NULL) | customerEmail, customerPhone, cartItems JSON                                                                                     | 30 days from `createdAt`                                                        | `abandoned-cart-purge` Inngest cron, weekly Sun 04:00 UTC                     | Recovery email scope ends ~14 days post-create              |
| `carts` (live shopping carts)                    | `customerId`, cart contents                                                                                                      | Until user empties OR account is erased                                         | Immediate on `eraseAccount` (hard delete); active carts have no retention cap | Service delivery                                            |
| `wishlists`                                      | `userId`, product list                                                                                                           | Until user removes OR account is erased                                         | Immediate on `eraseAccount` (hard delete)                                     | Service delivery                                            |
| `loyalty_points` / `loyalty_transactions`        | `customerId`, points balance / transaction history                                                                               | Until account is erased                                                         | Immediate on `eraseAccount` (hard delete)                                     | Loyalty program is account-scoped                           |
| `push_subscriptions`                             | `customerId`, endpoint, p256dh, auth                                                                                             | Until user revokes OR account is erased                                         | Immediate on `eraseAccount` (hard delete)                                     | Notification consent                                        |
| `onesignal_subscriptions`                        | `userId`, playerId, deviceLabel                                                                                                  | Until user revokes OR account is erased                                         | Immediate on `eraseAccount` (hard delete)                                     | Notification consent                                        |
| `refresh_tokens`                                 | `userId`, sha256 hash                                                                                                            | Token lifetime (1 year) or until revoked; immediate on `eraseAccount`           | Manual revoke + erase cascade                                                 | Session integrity                                           |
| `verification_tokens`                            | `userId`, sha256 hash                                                                                                            | 15 min lifetime; immediate on `eraseAccount`                                    | Auto-expiry via `expiresAt`                                                   | Email verification                                          |
| `audit_logs`                                     | `userId`, ip, userAgent, JSON details                                                                                            | 90 days hot in Postgres, then 7 years archived to R2                            | `audit-log-archive` Inngest cron, weekly Sun 03:00 UTC                        | SOX, ISO 27001 audit-trail; tamper-evident integrity record |
| `_prisma_migrations`                             | none                                                                                                                             | Indefinite                                                                      | None                                                                          | Schema integrity                                            |

## Erasure paths

There are three ways PII leaves the system, all routing through the
same `AuthService.eraseAccount(userId)` transaction so the wipe shape
is identical regardless of trigger:

1. **Self-serve**: `POST /auth/me/erase`, authenticated. Customer
   clicks "Delete my data" in the account UI.
2. **Retention cron**: `soft-deleted-user-anonymize` monthly. Catches
   soft-deleted users whose 12-month window has elapsed without
   them returning.
3. **Admin override** _(planned)_: `super_admin` button at
   `/admin/customers/[id]/erase` so a support agent can honor an
   email-based "please delete my data" request.

## Export path

`GET /auth/me/export`, authenticated. Returns the full JSON bundle
of every PII row tied to the user (every table in the matrix above
that references their `userId`/`customerId`). Required by GDPR
Art. 20 (data portability) and Kuwait Law 13/2023 Art. 20.

## Crons

| Function ID                           | Schedule (UTC) | Schedule (Asia/Kuwait) | What it does                                                       |
| ------------------------------------- | -------------- | ---------------------- | ------------------------------------------------------------------ |
| `audit-log-archive-weekly`            | `0 3 * * 0`    | Sun 06:00              | Archives `audit_logs` >90d to R2 JSONL, then deletes               |
| `abandoned-cart-purge-weekly`         | `0 4 * * 0`    | Sun 07:00              | Hard-deletes anonymous abandoned carts >30d                        |
| `soft-deleted-user-anonymize-monthly` | `0 2 1 * *`    | 1st of month 05:00     | Calls `eraseAccount` on customer users with `deletedAt` >12 months |

Three Sunday-morning passes are intentionally staggered an hour apart
to avoid Neon connection-pool overlap during the heaviest cleanup
window. The monthly user-anonymize lands a separate day from the
weekly sweeps so its retries (`retries: 2`) don't compound the Sunday
load.

## Future work

- **5y order anonymizer**: when the first FWB orders hit 5 years
  (earliest in 2026-12), add a cron that scrubs `shippingAddress` +
  `billingAddress` JSON to `{anonymized:true}` on `orders` whose
  `createdAt` is >5 years AND `customerId` IS NULL (already-erased
  customer). Until then there are no orders old enough to trigger.
- **Per-store retention overrides**: some merchants may want shorter
  retention for compliance with stricter regional regs. Today every
  store inherits the platform defaults above.
- **Backup retention** (corrected 2026-07-11 — the previous "9 commits via
  `prod-<sha>` branches" description was stale; per-commit Neon snapshots
  were retired 2026-06-08): recovery today is **Neon PITR (7-day window)**
  as the primary near-zero-RPO path, plus **daily encrypted `pg_dump`s to
  local Mac + R2 (30-day retention on both)** as the belt-and-suspenders
  layer. Full detail: `docs/DB-BACKUP-RESTORE.md`. Both layers mean an
  erased user's PII can persist in a backup for up to 30 days after
  erasure (the dump layer) — see `docs/privacy/data-map.md` § "Deletion &
  backups" for the full erasure-boundary writeup. The source of truth for
  live retention enforcement is still the DB columns above.
