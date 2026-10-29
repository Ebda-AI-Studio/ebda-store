# Production rollback — Ebda

> **Corrected 2026-10-10**: this doc was inherited from `ebda-store` and had never been adapted — it described a Railway-hosted API and pointed every Neon recovery command at **Ebda Store's own Neon project** (`crimson-king-40424588` / org `org-lingering-river-25973882`), not Ebda's. Running the old commands as written during a real Ebda incident would have operated on a different company's database. Fixed below: every deploy/rollback claim and every `neonctl` invocation now reflects Ebda's real topology.

This monorepo deploys **web / admin / orders / marketing to Cloudflare Workers** (one standalone, path-filtered GitHub Actions workflow per app — `cf-{web,admin,orders,marketing}-deploy.yml`, each `push:main` + `workflow_dispatch` → OpenNext build → `wrangler deploy`, workers `ebda-web` / `ebda-admin` / `ebda-orders` / `ebda-marketing`) + the **API, also Cloudflare Workers** (`cf-api-deploy.yml`, `ebda-api` — **`workflow_dispatch`-ONLY**, so a push to `main` does NOT redeploy it; see `docs/migration/railway-actions-deploy.md` for the cutover history — Railway is retired for this app). Plus **Neon Postgres** (project `ebda` = `lucky-truth-54548746`, org `org-proud-silence-64969971` — a SEPARATE Neon org from Ahmad's other projects, since this repo sits in the `Whisky-11` GitHub org; RLS via AsyncLocalStorage, `middleware/tenant-context.ts`) and **Cloudflare R2** for assets.

## Three rollback paths

### A. Per-worker fast-path — instant, no code change

Use when one Worker (or the API) is broken but the others + DB are fine. There is **NO one-click dashboard "Promote to Production"** like Vercel had — you roll back with the CLI.

Cloudflare Worker (admin / web / orders / marketing), from the app dir (e.g. `apps/web`):

```bash
# roll back to the immediately-previous version (fastest — instant, no rebuild)
npx wrangler rollback

# or pin a specific earlier version by id
npx wrangler versions list          # find the good version id
npx wrangler versions deploy <version-id>@100
```

> ⚠️ **A `wrangler rollback` / `wrangler versions deploy` is invisible to each `cf-{app}-deploy.yml`.**
> Its own per-app change-detection diffs from the sha of its last SUCCESSFUL run and assumes
> the worker is current as of it, so the rolled-back worker stays pinned to the old version
> until some later commit happens to touch its paths — with every run green. Once `main` is
> fixed, redeploy explicitly: `gh workflow run cf-{web,admin,orders,marketing,api}-deploy.yml`
> for whichever app you rolled back; never rely on the next push to catch it.

API fast-path (same mechanism, same worker type — `ebda-api` is a Worker, not a Railway service):

```bash
cd apps/api && npx wrangler rollback
# or pin a specific earlier version:
npx wrangler versions list && npx wrangler versions deploy <version-id>@100
```

⚠️ Admin, storefront, orders and the API often need to be in lock-step (shared API contracts via `@ebda/shared`). Rolling one Worker back without the others can break SSR fetches or API calls. If in doubt, prefer path B (revert the code so all surfaces rebuild from the same commit).

### B. Git revert + push (~2–5 minutes, all platforms)

Default. `scripts/rollback.sh` does this:

```bash
bash scripts/rollback.sh
```

Or manually:

```bash
git revert HEAD --no-edit
git push
```

Effect:

- `cf-{web,admin,orders,marketing}-deploy.yml` each re-run on the push and `wrangler deploy` the reverted Worker (~3–5 min, only the apps whose paths changed since that workflow's last successful run)
- the API auto-deploys on a push to `main` that touches `apps/api/**`, `packages/**`, the lockfile or the deploy config (`cf-api-deploy.yml`, Ruling API-AUTODEPLOY-1, 2026-10-25); `scripts/rollback.sh` also dispatches it explicitly; a manual `git revert && git push` must also run `gh workflow run cf-api-deploy.yml`, or the API stays on the old commit while the frontends roll back
- Background jobs (Workflows, Queues, Cron Triggers) ship with the API Worker version, so a rollback restores the previous job code too (Ruling G5-3: no Inngest fallback)
- OneSignal apps unchanged (no rebuild)

### C. Data rollback (PITR first, dump restore as fallback)

> **Full DR runbook: [`docs/DB-BACKUP-RESTORE.md`](./DB-BACKUP-RESTORE.md)** — decision table,
> the 4-layer strategy, exact restore commands, and the quarterly drill log. The summary below
> is the migration-specific slice.
>
> **Fastest path is Neon PITR (near-zero data loss), NOT the dump.** For a bad migration or
> data corruption inside the last **7 days**, branch production to a timestamp just before it
> and cut over — no data-since-backup loss, production untouched while you verify:
>
> ```bash
> ORG=org-proud-silence-64969971; PID=lucky-truth-54548746   # ebda (Whisky-11 Neon org — NOT Ahmad's default org)
> TS=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)
> neonctl branches create --project-id "$PID" --org-id "$ORG" --name recover --parent main --timestamp "$TS"
> # verify, then promote `recover` to primary in the Neon console (or repoint DATABASE_URL). See DB-BACKUP-RESTORE.md.
> ```

> **DR policy:** the dump layer is a daily local `pg_dump` on the developer Mac (launchd `com.ebda.neon-backup` → `~/.claude/scripts/backup-all-neon.sh`, 3:30am daily, 30-day retention at `~/Desktop/projects/_backups/ebda/`, entry registered in `~/.claude/scripts/lib/backup-projects.sh`) + a daily encrypted copy to R2. Per-commit Neon snapshot branches are NOT used for Ebda. Neon PITR (6-hour window, measured 2026-10-26) is the primary recovery mechanism; the off-machine encrypted dump in R2 (`ebda-db-backups`, nightly workflow `db-backup.yml`) is the answer for anything older than 6 hours or if PITR itself is unavailable.

Ebda uses **hand-written migrations** at `packages/database/prisma/migrations/<TS>_<name>/migration.sql`. They apply via the normal CI/deploy path, not a Railway `preDeployCommand` (that mechanism belongs to a different, Railway-hosted project and never applied here) — confirm a migration landed by checking `_prisma_migrations` directly:

```bash
DATABASE_URL="$(neonctl connection-string main --project-id lucky-truth-54548746 --org-id org-proud-silence-64969971 --role-name neondb_owner --database-name neondb)"
psql "$DATABASE_URL" -c "select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;"
```

If a migration-bearing commit is live (per `/health`'s `commit`) but its migration is missing from this list, apply it directly:

```bash
cd packages/database && DATABASE_URL="$DATABASE_URL" DIRECT_URL="$DATABASE_URL" npx prisma migrate deploy --schema=prisma/schema.prisma
```

---

Per `docs/ebda/...` and the strict-RLS migration, the project uses `ebda_app` (NOBYPASSRLS, enforced) for prod and `neondb_owner` for migrations/ops (RLS bypass, named hatches only — `withOwnerTx`/`createPrismaClient({ role: 'owner' })`). This doesn't affect rollback mechanics; just be aware which role is touching what.

#### Find the right backup

Backups are stored at `~/Desktop/projects/_backups/ebda/` on the developer Mac, one dump per day, 30-day rotation. Find the dump from before the bad commit:

```bash
# GLOBBED to *.sql.gz — an unglobbed `ls` also lists `.sql.gz.SUSPECT` files
# (a dump that failed verify-dump.sh, parked by scripts/backup-db.sh), and a
# fresh one sorts to the top as if it were the most recent good backup.
ls -lt ~/Desktop/projects/_backups/ebda/*.sql.gz
# The nightly dump needs NEON_API_KEY_EBDA (a Whisky 11-org key) in
# ~/.whisky-services.env — the default NEON_API_KEY is scoped to another org and
# fails with "no connection string" (it did, every night, until 2026-10-14).
# pick the dump timestamped before the bad deploy, then verify it BEFORE
# trusting it — present + correctly-named is not the same as restorable:
bash scripts/verify-dump.sh <chosen>.sql.gz
```

#### Restore from local pg_dump

The dumps are **plain gzip'd SQL** (`.sql.gz`) without `--clean`, so reset the target branch's
schema first, then `psql` the dump in a single transaction. (Full walkthrough +
decrypt-from-R2 variant in [`docs/DB-BACKUP-RESTORE.md`](./DB-BACKUP-RESTORE.md).)

```bash
ORG=org-proud-silence-64969971; PID=lucky-truth-54548746   # ebda
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Create a restore-target branch off production (branch name is `main`, not `production`)
neonctl branches create --project-id "$PID" --org-id "$ORG" --name restore-candidate --parent main
URL=$(neonctl connection-string restore-candidate --project-id "$PID" --org-id "$ORG" \
        --role-name neondb_owner --database-name neondb)

# 2. Reset schema on the isolated branch, then restore
psql "$URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
zcat < ~/Desktop/projects/_backups/ebda/<chosen>.sql.gz \
  | psql "$URL" --single-transaction -v ON_ERROR_STOP=1

# 3. Catch the branch up to head. Both DATABASE_URL and DIRECT_URL must point
#    at "$URL" — the schema's datasource reads DATABASE_URL directly
#    (packages/database/prisma/schema.prisma:16), so DIRECT_URL alone either
#    fails closed or silently runs against the operator's ambient .env
#    (production). This is NOT what re-creates RLS policies — see step 4.
psql "$URL" -c "select 'orders='||count(*) from orders;"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma

# 4. MEASURE RLS state before promoting — do not infer it from step 3's exit
#    code. A full pg_dump already contains every CREATE POLICY + ENABLE/FORCE
#    ROW LEVEL SECURITY statement as schema DDL, so the restore in step 2
#    should already carry them — but it also restores `_prisma_migrations`
#    fully-applied, so step 3 reports "No pending migrations" having run
#    zero SQL either way. Compare the same two counts against production
#    and this branch (full procedure, the per-table deny-all query, and the
#    idempotency status of every CREATE POLICY migration if a re-apply is
#    needed: docs/DB-BACKUP-RESTORE.md steps 5-6):
PROD_URL=$(neonctl connection-string main --project-id "$PID" --org-id "$ORG" \
        --role-name neondb_owner --database-name neondb)
for label_url in "prod:$PROD_URL" "restored:$URL"; do
  label="${label_url%%:*}"; target="${label_url#*:}"
  echo "-- $label --"
  psql "$target" -c "select count(*) as total_policies from pg_policies where schemaname = 'public';"
  psql "$target" -c "
    select count(*) as denyall_tables from (
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      left join pg_policy p on p.polrelid = c.oid
      where c.relkind = 'r' and c.relrowsecurity
      group by c.relname
      having count(p.polname) = 0
    ) denyall;
  "
done
# total_policies and denyall_tables BOTH match prod → promote restore-candidate
# to primary in the Neon console (Branches → main → Restore from branch).
# They don't match → do NOT promote; follow docs/DB-BACKUP-RESTORE.md step 6's
# targeted re-apply (replaying the whole migration history with psql errors on
# most of these files — most have no `DROP POLICY IF EXISTS`).
```

⚠️ **Restore is destructive to writes since the backup:** orders placed, products edited, store settings changed, R2 uploads referenced from new schema rows — all lost on restore. For Ebda this means **per-tenant data loss across every merchant's store**, not just one. Coordinate with Ahmad before doing this.

If write data since the backup must be preserved:

1. `pg_dump --table=<critical-tables> --data-only` from the broken DB
2. Restore the earlier snapshot
3. Re-insert the dumped rows (manually translate any column changes)

#### R2 cleanup if applicable

If the bad migration referenced new R2 keys (per-tenant uploads to `stores/<storeId>/...`), the R2 objects survive the DB rollback. Run the orphan audit after restore — **dry run first**, review the orphan list it writes, and only then re-run with `--apply` (deletes are irreversible; the audit's idea of "referenced" is only as complete as the `R2_REFERENCE_COLUMNS` registry in `apps/api/src/lib/r2-references.ts`):

```bash
# The API is a Worker now (no Railway exec shell) — run it locally against prod,
# with prod's R2 + DATABASE_URL env vars exported (see scripts/r2-orphan-audit.ts's
# header for the exact variable names):
npx tsx scripts/r2-orphan-audit.ts          # dry run: review /tmp/r2-orphans-*.txt
npx tsx scripts/r2-orphan-audit.ts --apply  # only after the review
```

#### Then revert the code

```bash
bash scripts/rollback.sh
```

## Visual builder revisions (`20261007170000_store_page_revisions`)

Additive table; nothing else references it. To roll the feature back: revert the code (path B) — the storefront and admin then read `stores.layout_settings` exactly as before, which every publish already back-wrote, so no data step is needed. To also drop the data: `DROP TABLE store_page_revisions;` and delete the row from `_prisma_migrations`. Re-check RLS state after any restore (`tests/integration/rls-ebda-app.test.ts`).

## Provider codes + credential blob (`20261007210000_payment_provider_codes`)

Expand step of rulings PROVIDERS-1/2. `payment_configs.provider` became TEXT (+ CHECK on a lowercase code) and three columns were added (`credentials` encrypted blob, `credential_hints`, `connection_test`); the legacy credential columns and the `"PaymentProvider"` enum type are still there. Rollback: revert the code, then `ALTER TABLE payment_configs DROP CONSTRAINT payment_configs_provider_code_check; ALTER TABLE payment_configs DROP COLUMN credentials, DROP COLUMN credential_hints, DROP COLUMN connection_test; ALTER TABLE payment_configs ALTER COLUMN provider TYPE "PaymentProvider" USING (provider::"PaymentProvider");` — the cast fails loudly if a row carries a code outside the enum. Rows saved through the new connect form keep their keys ONLY in `credentials`, so dropping it loses them: the merchant re-enters them (PROVIDERS-1 records 0 merchants in production on 2026-10-07; not re-read from production in this change). Delete the row from `_prisma_migrations` after reverting by hand.

## Shipping carrier catalog (`20261007230000_shipping_carrier_catalog`)

Expand step of rulings PROVIDERS-9/10. `shipping_carrier_configs` gained `test_mode` (default false), `credential_hints` and `connection_test`; the `credentials` column keeps its type and now holds a per-mode blob (a flat legacy blob is still read). Data steps in the same migration: iCarry configs deleted, iCarry shipments relabelled `manual` (carrier name "iCarry") with their COD remittance lines, every enabled config disabled (its credentials were never tested), `settings.sandbox = 'true'` rows set to `test_mode = true`. Rollback: revert the code, then `ALTER TABLE shipping_carrier_configs DROP COLUMN test_mode, DROP COLUMN credential_hints, DROP COLUMN connection_test;` and delete the row from `_prisma_migrations`. The data steps are NOT reversible by SQL: restore from the Neon PITR window taken before the deploy if the iCarry rows or the enabled flags must come back. A row saved after the deploy holds the new blob shape (`{sandbox, live, webhookSecret}`) which the previous code cannot read: merchants re-enter their carrier keys. Re-verify RLS state on the three touched tables after any restore (the migration lifts FORCE for its own transaction and restores it).

## Dahab template enum value (`20261008000000_store_template_dahab`)

Adds `dahab` to the `"StoreTemplate"` enum (builder Phase 3 pilot). Postgres cannot drop an enum value, so a rollback is: revert the code, move any store on the new value back (`UPDATE stores SET template = 'elegant' WHERE template = 'dahab';` — re-check RLS policy state after, per the note above), and leave the value unused. Delete the row from `_prisma_migrations` only if you also restore from a pre-migration branch.

## Qamar template enum value (`20261023000100_store_template_qamar`)

Adds `qamar` to the `"StoreTemplate"` enum (Phase B1; stamp 2026-10-23 so it sorts after the search and PR #91 migrations). Same shape as the Dahab value above: Postgres cannot drop an enum value, so a rollback is: revert the code, then `UPDATE stores SET template = 'minimal' WHERE template = 'qamar';` and redeploy (re-check RLS policy state after); the `look` column keeps the Qamar look and renders on `minimal` until the skin is back. Leave the enum value unused. Delete the row from `_prisma_migrations` only if you also restore from a pre-migration branch.

## Souq template enum value (`20261029000400_store_template_souq`)

Adds `souq` to the `"StoreTemplate"` enum (Phase B2; stamp 2026-10-29 so it sorts after main's newest migration (20261028000700, B2B); renumbered from 20261026000100 before merge (Ruling B2-27)). Same shape as the Qamar value above: Postgres cannot drop an enum value, so a rollback is: revert the code, then `UPDATE stores SET template = 'minimal' WHERE template = 'souq';` and redeploy (re-check RLS policy state after); the `look` column keeps the Souq look and renders on `minimal` until the skin is back. Leave the enum value unused. Delete the row from `_prisma_migrations` only if you also restore from a pre-migration branch.

## Jasmine template enum value (`20261030000100_store_template_jasmine`)

Adds `jasmine` to the `"StoreTemplate"` enum (Phase B3; stamp 2026-10-30 so it sorts after main's newest migration (20261029000400, Souq)). Same shape as the Souq value above: Postgres cannot drop an enum value, so a rollback is: revert the code, then `UPDATE stores SET template = 'minimal' WHERE template = 'jasmine';` and redeploy (re-check RLS policy state after); the `look` column keeps the Jasmine look and renders on `minimal` until the skin is back. Leave the enum value unused. Delete the row from `_prisma_migrations` only if you also restore from a pre-migration branch.

## Tag Arabic label (`20261030000200_tag_name_ar`)

Adds the nullable `tags.name_ar` column (Phase B3 fix wave 1; stamp 2026-10-30, sorts after `20261030000100_store_template_jasmine`). Additive only: code that does not read it ignores it, so the rollback is: revert the code and redeploy; the column can stay. To drop it after a code revert: `ALTER TABLE tags DROP COLUMN name_ar;` (the Arabic labels are lost; `tags.name` is untouched and remains the filter key).

## Lamma template enum value (`20261031000100_store_template_lamma`)

Adds `lamma` to the `"StoreTemplate"` enum (Phase B4; stamp 2026-10-31 so it sorts after main's newest migration (20261030000200, bilingual tags)). Same shape as the Jasmine value above: Postgres cannot drop an enum value, so a rollback is: revert the code, then `UPDATE stores SET template = 'minimal' WHERE template = 'lamma';` and redeploy (re-check RLS policy state after); the `look` column keeps the Lamma look and renders on `minimal` until the skin is back. Leave the enum value unused. Delete the row from `_prisma_migrations` only if you also restore from a pre-migration branch.

## Product 3D models (`20261008000020_product_3d_models`)

Two additive tables (`product_models`, `product_model_bindings`); every FK into them CASCADEs and nothing else references them. Feature-only rollback without a deploy: a super-admin `StoreFeature` override `product_3d = false` hides the viewer for that store (the public payload drops `model3d`). Code rollback: revert (path B); the PDP then renders photos only. To also drop the data: `DROP TABLE product_model_bindings, product_models;` and delete the row from `_prisma_migrations`; the `.glb`/`.usdz` objects under `stores/<id>/models/` become orphans for the weekly R2 sweep. Re-check RLS state after any restore (`tests/integration/rls-ebda-app.test.ts`).

## Gold-rate pricing (`20261102000200_gold_rate_pricing`)

Additive: three tables (`gold_rates`, `gold_rates_current`, `gold_rate_settings`), new nullable / defaulted columns on `products`, `product_variants`, `cart_items` and `order_items`, the price-guard triggers and two cron-facing functions. Every FK into the new tables cascades; nothing existing references them. **Feature-only rollback without a deploy:** `node scripts/gold-rate/freeze-all.mjs --store <slug>` (dry run first; `--apply` with Ahmad's `--yes-production` on production) turns each gold product into a fixed-price product at its current price through the service, which purges every price cache; then the store's `gold_rate_settings.enabled` stays on or off as the merchant likes, nothing reads it for a fixed product. **Code rollback:** safe to roll the API back to a version without the feature as long as no gold product exists, or after the freeze: the old code reads `price` like always, and the price-guard trigger only fires for rows whose `pricing_mode` is `gold_rate`. Do NOT drop the migration while `order_items.gold_snapshot` holds snapshots (they are the only record of how a past line was priced; refunds read them). The two Inngest crons (`gold-rate-feed-fetch`, `gold-rate-staleness-watch`) stop with the deploy that removes them.

## Trace: what migrated when

```bash
# Every migration ever added, sorted oldest-first
git log --all --diff-filter=A --name-only --pretty='%h | %aI | %s' -- packages/database/prisma/migrations/

# Migrations added in HEAD specifically
git diff HEAD~1 HEAD --name-only -- packages/database/prisma/migrations/
```

## Tenant-isolation gotcha

The RLS-via-AsyncLocalStorage pattern (`runInTenantContext`) sets `app.current_store_id` per request. If the migration changed RLS policy itself (added/removed policies, changed predicates), restoring the DB to a pre-policy state can leave the active code expecting NEW policy behavior. Always verify the RLS policy state after restore by impersonating a tenant and probing a controlled subset of rows.

## Semantic search indexer — stop the Workers AI spend

Flipping `SEARCH_SEMANTIC_ENABLED` to `false` (or rolling the API back to a version with it `false`) does **NOT** stop the indexer: `search-product-index` and `search-index-backstop` embed products whenever the `AI` binding exists (Ruling SEARCH-T11-8). The stop is `SEARCH_EMBED_STORE_DAILY_CAP=0` — see `docs/ENVIRONMENT.md` → "Semantic search — emergency stop" for the durable (wrangler `vars` + `cf-api-deploy.yml`) and emergency (dashboard variable, undone by the next deploy) routes. Rolling back to a version WITHOUT the `ai` binding (before PR 3) also stops it, at the cost of every other change since.

## Page revision publisher (`20261107000220_store_page_revisions_published_by`)

Additive, nullable. Rollback: `ALTER TABLE store_page_revisions DROP COLUMN published_by;` (history then simply shows no publisher; nothing else reads them).
