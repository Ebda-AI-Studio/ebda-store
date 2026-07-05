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

### C. Migration rollback (local pg_dump restore)

> **DR policy (2026-06-08):** Per-commit Neon snapshot branches (`neon-snapshot.yml`) are **retired** — they were accumulating branch cost without auto-pruning. DR is now daily local `pg_dump` runs on the developer Mac (launchd `com.forceai.neon-backup`, 3:30am daily, 30-day retention at `~/Desktop/projects/_backups/force-website-builder/`). The `neon-snapshot.yml` workflow is disabled.

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
ls -lt ~/Desktop/projects/_backups/force-website-builder/
# pick the dump timestamped before the bad deploy
```

#### Restore from local pg_dump

```bash
# 1. Create a restore-target Neon branch from production (so production is untouched during restore)
npx neonctl@latest branches create --name restore-candidate --parent production

# 2. Get the direct connection string for the restore branch
npx neonctl@latest cs restore-candidate --role-name neondb_owner

# 3. Restore the dump (pg_restore for custom format, psql for plain SQL)
pg_restore -d "<restore-branch-direct-url>" \
  ~/Desktop/projects/_backups/force-website-builder/<chosen-dump>.dump

# 4. Verify the restore branch looks correct, then swap production to it in the Neon console
#    Neon console → Branches → production → Reset from branch → restore-candidate
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
