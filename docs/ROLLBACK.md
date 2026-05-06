# Production rollback — Force Website Builder

This monorepo deploys to **3 platforms simultaneously**: Vercel admin (`app.forcemediakw.com`) + Vercel storefront (`store.forcemediakw.com` + per-tenant custom domains) + Railway API. Plus **Neon Postgres** (51 models, RLS via AsyncLocalStorage) and **Cloudflare R2** for assets.

## Three rollback paths

### A. Vercel-only fast-path per app (~30 seconds each)

Use when one Vercel app is broken but the other apps + API + DB are fine.

For admin:

1. https://vercel.com/ahmad-sharafs-projects/force-admin-seven/deployments
2. Three-dot menu on the previous successful prod deployment → **Promote to Production**

For storefront:

1. https://vercel.com/ahmad-sharafs-projects/force-web-sigma/deployments
2. Same flow.

⚠️ The admin and storefront often need to be in lock-step (shared API contracts via `@force/shared`). Promoting one without the other can break SSR fetches. Prefer path B unless you're sure.

### B. Git revert + push (~2–3 minutes, all platforms)

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

- Vercel admin rebuilds (~2 min)
- Vercel storefront rebuilds (~2 min)
- Railway API rebuilds (~2–3 min)
- Inngest functions auto-redeploy on next API boot
- OneSignal apps unchanged (no rebuild)

### C. Migration rollback (Neon snapshot restore)

FWB uses **hand-written migrations** at `packages/database/prisma/migrations/<TS>_<name>/migration.sql`. Migrations apply on next Railway API boot. So by the time you notice an issue, the migration is already live.

Per existing project memory, the project uses `force_app` role for prod (RLS enforced) + `neondb_owner` for migrations (RLS bypass). This doesn't affect rollback mechanics; just be aware which role is touching what.

#### Find the right snapshot

Every push to main creates a Neon branch named `prod-<short-sha>` via `.github/workflows/neon-snapshot.yml`. To find the snapshot from BEFORE the bad commit:

```bash
git log --oneline -5  # the previous good <sha> is the one you want
# matching Neon branch: prod-<that-short-sha>
```

Or list snapshots in https://console.neon.tech → force-website-builder → Branches.

#### Restore main

In the Neon dashboard:

1. Open the production branch (default `production`)
2. Click **Restore** → choose `prod-<good-sha>` as source
3. Confirm

⚠️ **Restore is destructive to writes since the bad migration:** orders placed, products edited, store settings changed, R2 uploads referenced from new schema rows — all lost on restore. For FWB this means **per-tenant data loss across multiple stores**. Coordinate with the Force team before doing this.

If write data must be preserved:

1. `pg_dump --table=<critical-tables> --data-only` from the broken DB
2. Restore the snapshot
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

Neon branches list at https://console.neon.tech is the parallel "what state did prod have at each commit" view.

## Tenant-isolation gotcha

The RLS-via-AsyncLocalStorage pattern (`runInTenantContext`) sets `app.current_store_id` per request. If the migration changed RLS policy itself (added/removed policies, changed predicates), restoring the DB to a pre-policy state can leave the active code expecting NEW policy behavior. Always verify the RLS policy state after restore by impersonating a tenant and probing a controlled subset of rows.

## Setup (one-time)

- `.github/workflows/neon-snapshot.yml` runs on push to main
- Repo secrets: `NEON_API_KEY`, `NEON_PROJECT_ID`
- Auto-prunes to last 9 `prod-*` branches
- Add via: Repo Settings → Secrets and variables → Actions
