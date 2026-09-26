# Production rollback — Force Website Builder

This monorepo deploys **web / admin / orders to Cloudflare Workers** (GitHub Actions `.github/workflows/cf-deploy.yml` → OpenNext build → `wrangler deploy`, workers `force-web-cf-preview` / `force-admin-cf-preview` / `force-orders-cf-preview`) + the **API to Railway** (git auto-deploy from `main`). Plus **Neon Postgres** (83 models, RLS via AsyncLocalStorage) and **Cloudflare R2** for assets.

## Three rollback paths

### A. Per-worker fast-path — instant, no code change

Use when one Worker (or the API) is broken but the others + DB are fine. There is **NO one-click dashboard "Promote to Production"** like Vercel had — you roll back with the CLI.

Cloudflare Worker (admin / web / orders), from the app dir (e.g. `apps/web`):

```bash
# roll back to the immediately-previous version (fastest — instant, no rebuild)
npx wrangler rollback

# or pin a specific earlier version by id
npx wrangler versions list          # find the good version id
npx wrangler versions deploy <version-id>@100
```

Railway API fast-path:

```bash
railway rollback                    # roll the API service back to the previous deployment
# or: Railway dashboard → api service → Deployments → redeploy a prior good deploy
```

⚠️ The admin and storefront often need to be in lock-step (shared API contracts via `@force/shared`). Rolling one Worker back without the other can break SSR fetches. If in doubt, prefer path B (revert the code so all surfaces rebuild from the same commit).

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

- `cf-deploy.yml` re-runs on the push and `wrangler deploy`s the reverted web / admin / orders Workers (~3–5 min, only the apps whose paths changed)
- Railway API auto-redeploys from `main` (~2–3 min)
- Inngest functions auto-redeploy on next API boot
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
> ORG=org-lingering-river-25973882; PID=crimson-king-40424588   # fwb-eu
> TS=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)
> neonctl branches create --project-id "$PID" --org-id "$ORG" --name recover --parent main --timestamp "$TS"
> # verify, then promote `recover` to primary in the Neon console (or repoint DATABASE_URL). See DB-BACKUP-RESTORE.md.
> ```

> **DR policy (2026-06-08):** Per-commit Neon snapshot branches (`neon-snapshot.yml`) are **retired** — they were accumulating branch cost without auto-pruning. The dump layer is a daily local `pg_dump` on the developer Mac (launchd `com.forceai.neon-backup`, 3:30am daily, 30-day retention at `~/Desktop/projects/_backups/force-website-builder/`) + a daily encrypted copy to R2. The `neon-snapshot.yml` workflow is disabled. Neon PITR (7-day window, raised 2026-07-06) is the primary recovery mechanism.

FWB uses **hand-written migrations** at `packages/database/prisma/migrations/<TS>_<name>/migration.sql`. Since commit `decd870` (2026-05-12), migrations apply automatically via Railway's `preDeployCommand` on every deploy — see "Migration auto-apply check" below. So by the time you notice an issue, the migration is already live.

> ⚠️ **Migration auto-apply check** — verify after EVERY migration-bearing push
>
> Railway's `railway.json:startCommand` for Dockerfile deploys runs in **exec form**, not shell form. The previous setup (`"startCommand": "npx prisma migrate deploy && node apps/api/dist/index.js"`) was silently broken: `&&` was parsed as a literal argument, so `prisma migrate deploy` ran fine but `node` was never invoked. Three deploys in a row (1066ea5, 44b6462, plus one before) failed health checks this way. The old container kept serving so the failure was invisible until someone watched deploy logs.
>
> **Current setup** uses `preDeployCommand` (runs migration on a one-off container before the new replica is promoted) + `startCommand` as plain `node apps/api/dist/index.js`.
>
> After pushing a migration-bearing commit, **watch the Railway deploy logs for the `preDeploy` phase**. You should see:
>
> ```
> [preDeploy] npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
> [preDeploy] Applying migration `<TS>_<name>`
> ```
>
> If the preDeploy phase is silent OR shows "No pending migrations to apply." right after a commit that introduces a new migration, the schema-vs-code mismatch will manifest as Prisma `P2022 column does not exist` errors at runtime. Recover with:
>
> ```bash
> # apply manually against prod Neon from your local machine
> cd packages/database && npx prisma migrate deploy --schema=prisma/schema.prisma
> # DATABASE_URL must point at prod Neon (check apps/api/.env)
> ```
>
> See [`feedback-railway-startcommand-exec-form.md`](~/.claude/projects/-Users-ahmadsharaf/memory/feedback-railway-startcommand-exec-form.md) for the full trap explanation.

---

Per existing project memory, the project uses `force_app` role for prod (RLS enforced) + `neondb_owner` for migrations (RLS bypass). This doesn't affect rollback mechanics; just be aware which role is touching what.

#### Find the right backup

Backups are stored at `~/Desktop/projects/_backups/force-website-builder/` on the developer Mac, one dump per day, 30-day rotation. Find the dump from before the bad commit:

```bash
# GLOBBED to *.sql.gz — an unglobbed `ls` also lists `.sql.gz.SUSPECT` files
# (a dump that failed verify-dump.sh, parked by scripts/backup-db.sh), and a
# fresh one sorts to the top as if it were the most recent good backup.
ls -lt ~/Desktop/projects/_backups/force-website-builder/*.sql.gz
# pick the dump timestamped before the bad deploy, then verify it BEFORE
# trusting it — present + correctly-named is not the same as restorable:
bash scripts/verify-dump.sh <chosen>.sql.gz
```

#### Restore from local pg_dump

The dumps are **plain gzip'd SQL** (`.sql.gz`) without `--clean`, so reset the target branch's
schema first, then `psql` the dump in a single transaction. (Full walkthrough +
decrypt-from-R2 variant in [`docs/DB-BACKUP-RESTORE.md`](./DB-BACKUP-RESTORE.md).)

```bash
ORG=org-lingering-river-25973882; PID=crimson-king-40424588   # fwb-eu
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Create a restore-target branch off production (branch name is `main`, not `production`)
neonctl branches create --project-id "$PID" --org-id "$ORG" --name restore-candidate --parent main
URL=$(neonctl connection-string restore-candidate --project-id "$PID" --org-id "$ORG" \
        --role-name neondb_owner --database-name neondb)

# 2. Reset schema on the isolated branch, then restore
psql "$URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
zcat < ~/Desktop/projects/_backups/force-website-builder/<chosen>.sql.gz \
  | psql "$URL" --single-transaction -v ON_ERROR_STOP=1

# 3. Re-apply RLS (dump restore does NOT preserve runtime policy wiring), verify, then
#    promote restore-candidate to primary in the Neon console (Branches → main → Restore from branch)
npm run db:rls
```

⚠️ **Restore is destructive to writes since the backup:** orders placed, products edited, store settings changed, R2 uploads referenced from new schema rows — all lost on restore. For FWB this means **per-tenant data loss across multiple stores**. Coordinate with the Force team before doing this.

If write data since the backup must be preserved:

1. `pg_dump --table=<critical-tables> --data-only` from the broken DB
2. Restore the earlier snapshot
3. Re-insert the dumped rows (manually translate any column changes)

#### R2 cleanup if applicable

If the bad migration referenced new R2 keys (per-tenant uploads to `stores/<storeId>/...`), the R2 objects survive the DB rollback. Run the orphan audit after restore:

```bash
railway run --service api -- npx tsx ../../scripts/r2-orphan-audit.ts --apply
```

#### Then revert the code

```bash
bash scripts/rollback.sh
```

## Trace: what migrated when

```bash
# Every migration ever added, sorted oldest-first
git log --all --diff-filter=A --name-only --pretty='%h | %aI | %s' -- packages/database/prisma/migrations/

# Migrations added in HEAD specifically
git diff HEAD~1 HEAD --name-only -- packages/database/prisma/migrations/
```

## Tenant-isolation gotcha

The RLS-via-AsyncLocalStorage pattern (`runInTenantContext`) sets `app.current_store_id` per request. If the migration changed RLS policy itself (added/removed policies, changed predicates), restoring the DB to a pre-policy state can leave the active code expecting NEW policy behavior. Always verify the RLS policy state after restore by impersonating a tenant and probing a controlled subset of rows.
