# DB index migrations — lock procedure

How to add (or drop) an index on the production Neon database without blocking writes. Companion to
[`DB-BACKUP-RESTORE.md`](./DB-BACKUP-RESTORE.md) and [`ROLLBACK.md`](./ROLLBACK.md). The index
audits that produce these changes live in [`docs/perf/`](./perf/).

## The constraint

- Migrations run through `prisma migrate deploy`: Railway's `preDeployCommand` (`railway.json`), and
  also the `Dockerfile.api` CMD before the API boots. A migration that waits on a lock delays the
  deploy.
- Prisma wraps **each migration file in a transaction**. `CREATE INDEX CONCURRENTLY` and
  `DROP INDEX CONCURRENTLY` cannot run inside a transaction, so a migration file can only hold a
  plain `CREATE INDEX` / `DROP INDEX`.
- A plain `CREATE INDEX` takes a `SHARE` lock. Reads continue, but **every INSERT/UPDATE/DELETE on
  that table waits** until the build finishes. A plain `DROP INDEX` takes `ACCESS EXCLUSIVE`, which
  blocks reads too, but it holds that lock only for the instant of the catalog change.

## Decision rule

| Table at build time                                                          | Procedure                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| Small: the build measures well under a second on a copy at production size   | Plain `CREATE INDEX IF NOT EXISTS` in the migration      |
| Large or write-hot: an order, payment or cart table in the 10⁵–10⁶ row range | Pre-build `CONCURRENTLY` out of band, then the migration |

Measure the build rather than guess it. Restore or seed a scratch database to production size, then
time the statement (`\timing on`). Reference points on a local PG 16:

| Index                                         | Rows    | Build   |
| --------------------------------------------- | ------- | ------- |
| GIN `gin_trgm_ops` on `orders.order_number`   | 100,000 | 0.70 s  |
| GIN `gin_trgm_ops` on one `users` text column | 20,000  | < 0.1 s |
| btree `ai_usage (created_at, cached_hit)`     | 25,000  | 13 ms   |

Write every index statement as `IF NOT EXISTS` (or `IF EXISTS` for drops), whichever path is taken.
That keeps the migration file the single source of truth and makes it a no-op on a database where
the index was pre-built.

## Pre-build procedure (large or write-hot tables)

1. Before merging, run the exact index statements from the migration with `CONCURRENTLY` against
   the **non-pooled** `DIRECT_URL`, in psql autocommit (no `BEGIN`), outside peak hours:

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_order_number_trgm_idx"
     ON "orders" USING gin ("order_number" gin_trgm_ops);
   ```

2. Confirm the build succeeded. A failed `CONCURRENTLY` build leaves an **INVALID** index behind,
   and `IF NOT EXISTS` would then silently skip it:

   ```sql
   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE NOT i.indisvalid;          -- must return 0 rows
   ```

   If it returns rows, `DROP INDEX CONCURRENTLY` the invalid index and retry.

3. Merge. `migrate deploy` then records the migration as applied without rebuilding anything.

This is the path the migration comments in `20260808120000_fk_only_indexes`,
`20260902120000_products_search_trgm_gin` and `20261002090000_order_search_trgm_and_fk_indexes`
refer to.

## Drops

Remove an index with its own reviewed migration, never bundled with an add. The candidate list,
with evidence, lives in the latest `docs/perf/index-audit-*.md`. On a large table, pre-drop with
`DROP INDEX CONCURRENTLY IF EXISTS` on `DIRECT_URL` first, so the migration's
`DROP INDEX IF EXISTS` becomes a no-op. Before dropping, check that the index does not back a
constraint or a foreign key (`pg_constraint.conindid`, and the FK-coverage query in the audit), and
that it was not created recently: `idx_scan = 0` on a new index only means it is new.

A redundant prefix index is dropped with a guarded `DO` block (see
`20261003110100_drop_redundant_prefix_indexes`): each drop runs only when its covering index exists
and is valid in that database, otherwise it raises a WARNING and keeps the short one. A migration is
one transaction, so the `ACCESS EXCLUSIVE` locks of its drops are held until it commits. That is
fine for small tables. Do not add a `lock_timeout` to a migration: a timeout records the migration
as FAILED and blocks every later deploy until `prisma migrate resolve`. For a big table, pre-drop
with `DROP INDEX CONCURRENTLY IF EXISTS` on `DIRECT_URL` and let the migration be the no-op.

Rolling a drop back means two things: run the migration's `rollback.sql` (recreates the indexes with
`CREATE INDEX CONCURRENTLY`) and revert the PR so `schema.prisma` declares the `@@index` lines again.

## Trigram (GIN) indexes and Prisma drift

Prisma's schema does not declare the `gin_trgm_ops` indexes. They are raw SQL in their migrations,
with a comment on the owning model. As a result, `prisma migrate diff` and `migrate dev` propose
`DROP INDEX` for:

- `products_{name,name_ar,description,description_ar}_trgm_idx`
- `orders_order_number_trgm_idx`
- `users_{first_name,last_name,email,phone}_trgm_idx`
- `orders_guest_{first_name,last_name,email,phone}_trgm_idx` (partial, on the `shipping_address ->> '<key>'`
  expression; Prisma cannot declare either)

**Never accept that drop.** Each one backs a leading-wildcard ILIKE search. A BitmapOr needs every
arm of an OR indexed, so dropping any one of them returns its whole search to a sequential scan.
`pg_trgm` is installed in production. Its migrations run `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
and rollbacks never drop it.

## Rollback

Every index migration ships a `rollback.sql` next to it, with `DROP INDEX CONCURRENTLY IF EXISTS`
statements run on `DIRECT_URL` in autocommit. Dropping an index loses no data; the affected reads
go back to sequential scans. If the index came with a query rewrite, roll the code back first.

## Reading pg_stat_statements

`pg_stat_statements` is enabled by migration `20261003110000_enable_pg_stat_statements`. Neon
preloads the library, so statistics accumulate from the moment the extension exists. Run these on
the non-pooled `DIRECT_URL` as `neondb_owner` (a member of `pg_read_all_stats`, which is what makes
other roles' statement text visible), read-only:

```sql
-- since when is this window? (the counters are in memory; they start over on a stats reset
-- and are not a long-term record: copy anything you need into the audit doc)
SELECT stats_reset, dealloc FROM pg_stat_statements_info;

-- top statements by total time: where the database actually spends its time
SELECT queryid, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       round(max_exec_time::numeric, 1)   AS max_ms,
       rows, shared_blks_read, left(query, 160) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC LIMIT 20;

-- buffers touched per call: a statement that reads thousands of blocks per call for a few rows
-- is a missing index (this is how to attribute the carts / cart_items sequential scans)
SELECT queryid, calls, (shared_blks_hit + shared_blks_read) / calls AS blks_per_call,
       rows / calls AS rows_per_call, left(query, 160) AS query
FROM pg_stat_statements
WHERE calls > 100 AND query ILIKE '%"carts"%'
ORDER BY (shared_blks_hit + shared_blks_read) / calls DESC LIMIT 20;
```

Reading the output:

- Prisma issues parameterised statements, so `query` shows `$1`, `$2`: the bound values (a phone,
  an email, a search term) are never stored. Do not paste a statement into a ticket with its
  parameters filled in.
- Rank by `total_exec_time` first (what to fix), then by `mean_exec_time` and `max_exec_time` (what a
  user feels). A cheap statement called a million times beats a slow one called twice.
- `rows / calls` against `blks_per_call` separates a missing index (many blocks, few rows) from a
  genuinely large result.
- To take a clean measurement after a deploy or an index change, `SELECT pg_stat_statements_reset();`,
  wait for traffic, then query. Do this deliberately: it discards everyone's window.
- `pg_stat_statements.track` is `top`, so statements inside functions are not listed separately.
- Pair a finding with `EXPLAIN (ANALYZE, BUFFERS)` of that statement on a scratch copy at production
  size before adding or dropping an index.
