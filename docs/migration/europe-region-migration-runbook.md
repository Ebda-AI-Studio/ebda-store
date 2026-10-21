# Europe region migration runbook — Ebda Store + WBS → Frankfurt/Netherlands

> **Goal:** move both Force backends to the region closest to Egypt.
> **Target:** Neon **`aws-eu-central-1` (Frankfurt)** + Railway **`europe-west4` (Amsterdam, NL)**.
> Frankfurt↔Amsterdam ≈ 10 ms (co-located); ~80 ms to Egypt vs ~120 ms Singapore / ~180 ms US-East.
> **Status: RUNBOOK — execute deliberately, WBS first, then Ebda Store, each in a short write-freeze.**

## Why a runbook and not a script

Both targets are **production**. Ebda Store serves a **live merchant (demo-merchant)** taking payments, and
its DB has **86 RLS-enabled tables / 91 policies + a custom the earlier app role** driving tenant
isolation. A botched restore = **cross-tenant data leak (P0)** or a dead app. So every cutover has
a hard **RLS re-verification gate** before traffic flips. Neon can't relocate a project in place —
you create a NEW project in Frankfurt and dump/restore into it.

## Measured facts (2026-06-27)

|                  | Ebda Store (`silent-sun-13697505`, SG)                | WBS (`lively-sun-42203294`, US-East)                               |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Extensions       | `plpgsql` only (trivial)                       | confirm before run                                                 |
| RLS              | 86 tables / 91 policies                        | confirm before run                                                 |
| Custom roles     | the earlier app role (+ `neondb_owner`, `neon_service`) | confirm before run                                                 |
| DB size          | ~56 MB (dump = seconds)                        | confirm (likely bigger — self-hosted PG + history)                 |
| Railway services | `api` + `Redis`                                | `whatsapp-broadcaster` + `Redis` + `vigilant-peace` (its Postgres) |

## Pre-flight (do once, before either cutover)

1. **Clear the Railway "subscription past due" banner.** A past-due account can block region changes/redeploys, and the standby depends on Railway staying alive.
2. Confirm tooling: `pg_dump`/`pg_restore`/`psql` **≥ PG17** (`brew install postgresql@17`; PG14 silently mis-dumps a PG17 server), `neonctl` authed (org `org-lingering-river-25973882`), Railway CLI authed.
3. Pick a **low-traffic window** (≈ 05:00–07:00 Egypt is lowest). A 56 MB DB needs only a few minutes of freeze.
4. **Order: WBS first** (internal, low-stakes — proves the runbook), **then Ebda Store** (live merchant).

## Per-service cutover (run top-to-bottom, one service at a time)

### Phase 0 — provision the Frankfurt target (no downtime)

- Create the Neon project in Frankfurt:
  `neonctl projects create --name "<svc>-eu" --region-id aws-eu-central-1 --org-id org-lingering-river-25973882`
- Capture the new project id + the **pooled** (`-pooler`) and **direct** connection strings
  (`neonctl connection-string … --pooled` / without `--pooled`).
- **Recreate the custom role(s) FIRST** (a single-DB `pg_dump` does NOT include cluster roles, and
  the RLS policies reference the earlier app role). On the new project:
  `CREATE ROLE the earlier app role NOLOGIN;` (+ any GRANTs the app relies on — dump them from source with
  `pg_dumpall --roles-only` filtered to the earlier app role, or recreate from the source `\du`/grant audit).

### Phase 1 — dry-run restore (no downtime, fully reversible — DO THIS BEFORE the freeze)

- Dump source → restore into Frankfurt as a **verification copy** while prod stays live:
  `pg_dump "<source_direct_url>" -Fc --no-owner --no-privileges -f /tmp/<svc>.dump`
  `pg_restore --no-owner --role=neondb_owner -d "<frankfurt_direct_url>" /tmp/<svc>.dump`
  (RLS policies + `ENABLE ROW LEVEL SECURITY` ride in the dump; `--no-owner`/`--role` map ownership to `neondb_owner`.)
- **VERIFY GATE (must all pass):**
  - extensions present (`plpgsql`); `SELECT count(*) FROM pg_policies WHERE schemaname='public'` == **91 (Ebda Store)**;
    RLS-enabled table count == **86 (Ebda Store)**; the earlier app role exists.
  - per-table row counts match source (spot-check the big/critical tables: products, orders, payments, stores, carts).
  - **tenant-isolation test:** set the tenant GUC to store A, confirm a read returns ONLY store A and CANNOT see store B. This is the gate that prevents a P0 leak.
- If any check fails → fix the role/grant/policy gap and re-restore. **Do not proceed to cutover until green.**

### Phase 2 — cutover (SHORT write-freeze)

- Announce/begin the freeze (lowest-traffic window). Put the API into maintenance or accept a brief write-pause.
- **Final delta:** re-run the Phase-1 dump/restore into a fresh DB on the Frankfurt project (tiny DB → seconds) so no writes since the dry-run are lost. Re-run the VERIFY GATE quickly (policy count + tenant test + row counts).
- **Swap Railway env** on the service: `DATABASE_URL` → Frankfurt **pooled** URL, `DIRECT_URL` → Frankfurt **direct** URL. (Keep the same `appendPoolParams` behavior — pgbouncer/connection_limit are added in code.)
- **Change the Railway service region → `europe-west4`** (dashboard: service → Settings → Region) and redeploy.
- **Smoke test:** health 200, login, storefront renders a store, place one write (test order), confirm RLS still isolates, payment webhook path intact.
- End the freeze.

### Phase 3 — post-cutover

- Update backup automation: `~/.claude/scripts/backup-all-neon.sh` discovers projects via neonctl, but verify it picks up the new Frankfurt project and drops the old; update any hard-coded project ids.
- Keep the **old Singapore/US-East project for ~7 days** as instant rollback, then delete to avoid extra-project charges.
- Update `CLAUDE.md` / memory: new region + new Neon project ids.

## Rollback (any phase before Phase-3 cleanup)

Revert the Railway service's `DATABASE_URL`/`DIRECT_URL` to the OLD (Singapore/US-East) endpoints and
set the region back; redeploy. The old project is untouched during the migration, so rollback is a
~2-minute env swap. (This is why the old project is kept 7 days.)

## WBS specifics (run first)

WBS self-hosts its Postgres (`vigilant-peace`) on Railway — that's a **different migration shape**: it's
not Neon today. Decide: (a) move it to a **new Neon Frankfurt project** (recommended — consolidates onto
Neon + gets backups/branching) and repoint WBS at it, or (b) keep self-hosted PG but move the Railway
service to `europe-west4`. Option (a) aligns with the Ebda Store stack and the shared-Upstash HA plan. Confirm
WBS's RLS/role/extension footprint with the same VERIFY GATE before cutover.

## Open coordination points (need Ahmad)

- Clear the Railway **past-due** banner (blocks region change).
- The **Railway region toggle** is a dashboard action.
- Approve the **write-freeze window** for Ebda Store (the live merchant).
