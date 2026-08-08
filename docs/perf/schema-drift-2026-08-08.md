# Schema drift inventory — 2026-08-08

`prisma migrate diff --from-migrations ./migrations --to-schema-datamodel schema.prisma`
reports **212 lines** of difference. This is the categorized inventory, so the
next person does not have to re-derive it.

## ⚠️ It is a THREE-way divergence, not two-way

The obvious assumption — "production is built from `migrations/`, so a
migrations-built shadow DB equals production" — **is false here, verified against
production on 2026-08-08**:

|                            | `_prisma_migrations` | `payments.stripe_*` | any `products` sku index |
| -------------------------- | -------------------- | ------------------- | ------------------------ |
| migrations-built shadow DB | 110 applied          | **present**         | —                        |
| **actual production**      | **110 applied**      | **ABSENT**          | **none**                 |

Production reports every one of the 110 migrations applied, and the folder holds
exactly 110 — yet its DDL does not match what replaying those 110 produces. Some
DDL was applied to production out-of-band.

**Consequence: `migrate diff --from-migrations` describes the migrations folder,
NOT production.** Treat it as a lead, and confirm every item against the live
database before acting. Several entries below turned out to be already-done or
non-existent in production once actually checked.

## Why this is a backlog and not an accident

`20260608020427_add_mfa_and_token_version/migration.sql` documents an earlier
`prisma migrate dev` run that captured this whole pile at once and had it stripped
back out:

> None of that belongs to this feature and most of it was destructive /
> boot-failure-prone, so it was removed. If any of those schema changes are
> genuinely intended, they must ship in their own dedicated, reviewed migration.

That instruction still stands. **Do not resolve this by running `prisma migrate dev`
and committing whatever it emits** — that is exactly the failure mode above, and it
would drop production columns.

## Category 1 — declared but never migrated (production is MISSING these)

| object                                   | status                                                 |
| ---------------------------------------- | ------------------------------------------------------ |
| `verification_tokens (type)`             | **FIXED** in `20260808180000_missing_declared_indexes` |
| `product_variants (product_id, barcode)` | **FALSE POSITIVE — see below**                         |
| `products UNIQUE (store_id, sku)`        | **NOT fixed — see below**                              |

### The SKU unique constraint — FIXED, and the naive check was wrong

`schema.prisma` has always declared:

```prisma
@@unique([storeId, sku]) // Prevent duplicate SKUs within a store (null values are excluded)
```

No migration ever created it, so production had **no `products.sku` index of any
kind** and nothing stopped two live products in a store sharing a SKU.

**The check that says it is safe to add must include soft-deleted rows.** The
obvious query filters `deleted_at IS NULL` and returns 0 — but the plain unique
index Prisma would generate has **no WHERE clause**, so it also covers
soft-deleted rows. Against production:

```sql
-- deleted_at IS NULL  -> 0 rows        (looks safe: WRONG)
-- no deleted_at filter -> 1 row        (store 0bbf478a…, sku S-0015)
```

That row is a merchant who soft-deleted an Arabic-titled product and recreated it
in English reusing the SKU — normal, correct behaviour. A plain unique index
would have **failed at CREATE time**, and since FWB applies migrations on API
boot, that failure is an outage.

**Shipped as a PARTIAL unique index** (`WHERE deleted_at IS NULL`), which is also
the correct business rule: uniqueness among live products, with SKU reuse allowed
after deletion. Built out-of-band with `CREATE UNIQUE INDEX CONCURRENTLY` before
the migration merged; the migration statement is `IF NOT EXISTS` so it is a no-op
on production and creates it normally on a fresh/CI database.

Verified in production: `indisvalid=true`, and a duplicate insert is rejected
with `duplicate key value violates unique constraint "products_store_id_sku_key"`
(tested inside a transaction and rolled back).

**Accepted drift:** Prisma cannot express partial indexes, so `migrate diff` will
report this as missing forever. The `@@unique` stays in `schema.prisma` so intent
stays visible, but any `prisma migrate dev` output touching it must be discarded.

### `product_variants (product_id, barcode)` is a permanent false positive

It already exists, created by `20260615000000_barcode_scanning` as a **PARTIAL**
index:

```sql
CREATE INDEX ... ON public.product_variants (product_id, barcode) WHERE (barcode IS NOT NULL)
```

`schema.prisma` declares a plain `@@index([productId, barcode])` because Prisma
**cannot express a partial index**. `migrate diff` therefore reports it as missing
forever, even though production has it — and has the better, smaller version
(most variants have no barcode). Adding a second full index over the same columns
would be pure write-amplification for zero read benefit.

This was caught only by querying `pg_indexes` on a migrations-built shadow DB
after the "fix" appeared not to work. **Any `[+] Added index` in this diff must be
checked against `pg_indexes` before being treated as missing** — Prisma's
inability to express partial/expression indexes makes the diff over-report.

## Category 2 — looked destructive, turned out to be a non-issue

**RESOLVED — there is nothing to drop.** The diff lists
`payments.stripe_payment_intent_id`, `stripe_refund_id` and `stripe_session_id`
as present-in-migrations / absent-from-schema, which reads like "production has
dead columns". It does not:

```
ERROR:  column "stripe_payment_intent_id" does not exist
```

Production has **no** `stripe%` columns on `payments` at all. They exist only in
a migrations-built replay. This entry is an artifact of the three-way divergence
above and needs no destructive migration — which is exactly why the check had to
be run against production rather than acted on from the diff.

## Category 3 — cosmetic, deliberately not fixed

- **~23 index renames.** The index exists in production under a different name than
  Prisma derives (e.g. `warehouses_store_id_default_idx` vs
  `warehouses_store_id_is_default_idx`, `whatsapp_templates_store_status` vs
  `whatsapp_templates_store_id_status_idx`). Functionally identical; renaming takes
  a lock on a live table for zero benefit.
- **~19 column type changes + ~14 default changes**, mostly `created_at`/`updated_at`
  precision and `Some(Now)` vs `None`. Need per-column review; several are Prisma
  representing the same Postgres type differently.
- **FK drop/re-add pairs** (8 × `store_id`, 5 × `variant_id`, 4 × `product_id`) —
  Prisma re-emitting an identical constraint under a different name.
- **PK drop/add on `ai_recommendation` and `product_daily_views`** — constraint-name
  differences, not structural changes.

These are noise in the diff but they are the reason the diff cannot be used as a
go/no-go signal. Until they are reconciled, **`migrate diff` will never be clean**,
so treat "no NEW drift for the objects I touched" as the passing bar — that is what
`scripts/audit-fk-indexes.py` and the per-PR shadow-DB check in
`docs/perf/index-audit-2026-08-fk-coverage.md` actually verify.

## Re-run

```bash
createdb fwb_drift_shadow
SHADOW="postgresql://$USER@localhost:5432/fwb_drift_shadow"
DATABASE_URL="$SHADOW" DIRECT_URL="$SHADOW" npx prisma migrate diff \
  --from-migrations packages/database/prisma/migrations \
  --to-schema-datamodel packages/database/prisma/schema.prisma \
  --shadow-database-url "$SHADOW"
```
