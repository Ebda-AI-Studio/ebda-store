# Database backup, restore & disaster recovery

Canonical DR runbook for the FWB Neon Postgres database. Three independent layers,
all **$0**. Every restore path below has been **drilled end-to-end** — see the drill log
at the bottom. When something goes wrong, start at the decision table.

## Which path do I use? (decision table)

| Situation                                                                             | Use                         | RPO (data lost) | RTO (time to recover) |
| ------------------------------------------------------------------------------------- | --------------------------- | --------------- | --------------------- |
| Bad migration / accidental `DELETE` / app corrupted rows — **within the last 7 days** | **Layer 0 — Neon PITR**     | seconds         | ~2–5 min              |
| Same, but older than 7 days                                                           | Layer 1/2 — dump restore    | up to 24h       | ~5–10 min             |
| Neon project deleted / account lost / provider outage                                 | Layer 2 — R2 encrypted dump | up to 24h       | ~10–20 min            |
| Local Mac dead but need a dump                                                        | Layer 2 — R2 encrypted dump | up to 24h       | ~10–20 min            |
| Just need last night's data locally                                                   | Layer 1 — local `.sql.gz`   | up to 24h       | ~5 min                |

**Default to Layer 0 (PITR).** It is the primary mechanism, near-zero data loss, and
never touches production while you verify. The dumps are the belt-and-suspenders for the
cases PITR can't cover (older than the window, or Neon itself is gone).

## The 4-layer strategy (what global companies do, and where we stand)

| Layer                      | RPO              | What it is                                                                                                   | Status                                              |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Continuous WAL / PITR**  | seconds–minutes  | Restore/branch to any timestamp. Neon does this natively via branch-at-timestamp                             | ✅ **7-day window** (raised from 24h on 2026-07-06) |
| **Periodic logical dumps** | = interval (24h) | `pg_dump` → independent storage; survives provider loss / account compromise / "someone deleted the project" | ✅ daily → local + R2                               |
| **3-2-1 rule**             | —                | 3 copies, 2 media, 1 off-site                                                                                | ✅ Neon (primary) + local Mac + R2                  |
| **GFS retention tiering**  | —                | daily 30d → weekly 90d → monthly 1yr (compliance long-tail)                                                  | ⚠️ flat 30d today (GFS is the next hardening step)  |

---

## Layer 0 — Neon Point-in-Time Recovery (PITR) · primary, near-zero RPO

Neon continuously retains WAL, so you can spin up an **isolated branch** of the database
as it existed at **any timestamp in the last 7 days** — without touching production. This
is the fastest recovery for the common failure modes (a migration nuked a column, a script
mass-deleted rows, a bug corrupted data 20 minutes ago).

- **Window:** 7 days (`history_retention_seconds = 604800`). Raised from the 1-day default
  on 2026-07-06. To change: `PATCH /projects/<id>` with `{"project":{"history_retention_seconds":<sec>}}`
  (there is no `neonctl` flag for it). Launch plan supports up to 7 days.
- **Cost:** ~$0 — it's WAL already being written; branches are copy-on-write.

### Restore with PITR

```bash
ORG=org-lingering-river-25973882
PID=crimson-king-40424588            # fwb-eu  (wbs-eu = spring-dew-80973306)
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Branch production (branch name: main) to the moment BEFORE the incident.
#    Timestamp is ISO-8601 UTC. Example: 15 minutes ago.
TS=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)
neonctl branches create --project-id "$PID" --org-id "$ORG" \
  --name recover --parent main --timestamp "$TS"

# 2. Get its direct connection string and VERIFY the data is what you expect.
URL=$(neonctl connection-string recover --project-id "$PID" --org-id "$ORG" \
        --role-name neondb_owner --database-name neondb)
psql "$URL" -c "select count(*) from orders;"   # sanity-check the recovered state

# 3a. FAST PATH — repoint the app at the recovery branch:
#     set DATABASE_URL/DIRECT_URL (Railway) to the branch's pooled/direct strings, redeploy.
# 3b. FULL PATH — make the recovery branch the new primary in the Neon console:
#     Neon console -> Branches -> main -> "Restore" / "Set as primary" from `recover`.
#     (This is the clean cutover; the old primary is kept as a branch for forensics.)

# 4. When done, delete throwaway branches so only `main` remains (branch hygiene):
neonctl branches delete recover --project-id "$PID" --org-id "$ORG"
```

**RLS note:** a PITR branch preserves roles + policies (it's a real WAL branch), so unlike a
dump restore you do **not** re-apply RLS. Still verify tenant isolation after any cutover.

---

## Layer 1 — local daily dumps (Mac, launchd)

Central script `~/.claude/scripts/backup-all-neon.sh` (launchd `com.forceai.neon-backup`,
03:30 daily; runs on next wake if the Mac slept) gzip-dumps every Force Neon DB to
`~/Desktop/projects/_backups/<project>/`, keeps **30** (~1 month).

- **Location (FWB):** `~/Desktop/projects/_backups/force-website-builder/`
- **Size:** ~19 MB total for the whole 30-day window; latest single dump ≈ **1.4 MB gzipped**
  (the entire DB — it's small). Files are `<UTC-timestamp>.sql.gz` (plaintext gzip) plus the
  `.sql.gz.enc` copies pushed off-site.
- **Requires** `pg_dump` ≥ the Neon server major (PG17 → `brew install postgresql@17`;
  pg_dump 14 aborts against a PG17 server and the pipeline gzips the empty stream into a
  valid 20-byte archive — measured 2026-09-17, six such files were found locally, see
  `docs/plans/2026-09-17-db-backup-assert-dump.md`) and the **DIRECT**
  (non-pooler) URL, which the script pulls from Neon via `neonctl --role-name neondb_owner`
  (full-privilege, includes RLS tables) — independent of any repo `.env`.

## Layer 2 — off-machine encrypted (GitHub Actions → private R2)

`.github/workflows/db-backup.yml` runs daily 03:50 UTC (+ `workflow_dispatch`): `pg_dump 17`
→ gzip → **verify** → AES-256-CBC (openssl, pbkdf2) → upload to `s3://databasebackup/<project>/`.
Prunes objects >30 days (bucket also has a 30-day lifecycle rule). Mac-independent — this is
what survives the laptop dying.

**The dump is asserted before it is encrypted** (`scripts/verify-dump.sh`, added 2026-09-17):
gzip integrity → decompressed floor (1KB) → `-- PostgreSQL database dump` header → at least one
`CREATE TABLE` → **data rows ≥ tables**. The row assertion is the one with teeth: a schema-only
dump is a few KB, clears any byte floor, and restores an empty database — which is exactly how
the Force Media CRM archived 30 consecutive nightly "successes" over five weeks against a
database that had already been wiped. Verification happens on the PLAINTEXT because an encrypted
blob cannot be inspected later without the key. A failed assertion **fails the job, fires the
Telegram alert, and uploads nothing** — a missing backup is loud, a worthless one is silent.

### Required repo secrets

`DATABASE_URL_DIRECT` (Neon direct owner url) · `BACKUP_ENCRYPTION_KEY` (`openssl rand -hex 32`
— **SAVE IT**, needed to decrypt/restore; also stashed at `~/.claude/.<project>-backup-key`) ·
`R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET=databasebackup`.

---

## Restore from a dump (Layer 1 or 2)

Use when PITR can't cover it (older than 7 days, or Neon itself is gone). **Always restore
into a fresh Neon branch or a scratch DB first — never straight over production.**

```bash
ORG=org-lingering-river-25973882
PID=crimson-king-40424588
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Pick the dump. Local plaintext — GLOBBED to *.sql.gz, not a bare `ls`:
#    an unglobbed listing also shows `.sql.gz.SUSPECT` files (a dump that
#    FAILED verify-dump.sh, parked by scripts/backup-db.sh — see below), and
#    a fresh one sorts to the top of `ls -lt` as if it were the most recent
#    good backup.
ls -lt ~/Desktop/projects/_backups/force-website-builder/*.sql.gz
DUMP=~/Desktop/projects/_backups/force-website-builder/<chosen>.sql.gz
#    …or fetch + decrypt an R2 copy:
#    KEY=$(cat ~/.claude/.force-website-builder-backup-key)
#    openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$KEY" \
#      -in <chosen>.sql.gz.enc -out <chosen>.sql.gz

# 1a. Verify BEFORE trusting it — a dump can be present, correctly named, and
#     still restore nothing (see the "Verify a dump is valid" note below).
bash scripts/verify-dump.sh "$DUMP"

# 2. Create an isolated restore-target branch off production.
neonctl branches create --project-id "$PID" --org-id "$ORG" --name restore-candidate --parent main
URL=$(neonctl connection-string restore-candidate --project-id "$PID" --org-id "$ORG" \
        --role-name neondb_owner --database-name neondb)

# 3. The dumps are plain-format WITHOUT --clean, so reset the branch schema first,
#    then restore in a single transaction (all-or-nothing; ~5 min for FWB from Frankfurt).
psql "$URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
zcat < "$DUMP" | psql "$URL" --single-transaction -v ON_ERROR_STOP=1

# 4. Verify data landed, then catch the restored branch up to head. Both
#    DATABASE_URL and DIRECT_URL must point at "$URL" — the schema's
#    datasource reads DATABASE_URL directly (packages/database/prisma/
#    schema.prisma:16), so DIRECT_URL alone either fails closed ("Environment
#    variable not found: DATABASE_URL") or silently runs against whatever
#    DATABASE_URL sits in the operator's ambient .env — production.
psql "$URL" -c "select 'orders='||count(*) from orders;"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
# ^ This catches ONLY migrations added AFTER the dump was taken — it is a
#   genuine no-op if none exist, which is normal. It is NOT what re-creates
#   RLS policies: a full pg_dump (no --exclude-table, no --data-only — see
#   .github/workflows/db-backup.yml) already contains every CREATE POLICY and
#   ENABLE/FORCE ROW LEVEL SECURITY statement as ordinary schema DDL, so
#   step 3's restore already carries them. It ALSO restores `_prisma_migrations`
#   fully-applied, so `migrate deploy` reports "No pending migrations" having
#   run zero SQL either way — a clean exit here is evidence there was nothing
#   newer than the dump, never evidence RLS survived. Measure that instead.

# 5. MEASURE RLS state — compare the SAME two counts against production and
#    this branch. Don't infer policy presence from step 4's exit code.
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
# denyall_tables is the same query as docs/plans/2026-07-02-rls-cutover.md
# Phase 0's deny-all detector, wrapped to a scalar count (that doc's version
# lists the table names — rerun it unwrapped in step 6 if you need names).
# webhook_events has RLS intentionally never enabled (all access via
# withRlsBypass) — it is invisible to both queries (relrowsecurity is false),
# not a gap; see the RLS matrix in docs/audits/2026-07-16-rls-cutover-readiness-map.md §1.

# 6. total_policies and denyall_tables BOTH match prod exactly → RLS survived
#    the restore intact. Proceed to cut over.
#
#    They DON'T match → the dump's policy DDL was lost or partial (first
#    confirm the dump command itself ran without --exclude-table/--data-only
#    before assuming Postgres dropped something). Re-run Phase 0's UNGROUPED
#    query against "$URL" to get the actual missing table names, then
#    re-apply ONLY those tables' policies from the migration that created
#    them. Do NOT replay the whole migration history with psql — most of
#    these files have no `DROP POLICY IF EXISTS`, so re-running one whose
#    policies already exist errors ("policy ... already exists") and aborts
#    the rest of that file's statements. Migrations containing
#    `CREATE POLICY`, oldest first (idempotent = safe to re-run with
#    `psql -f <path>/migration.sql`; NOT idempotent = prefix every
#    CREATE POLICY you re-run from it with a matching
#    `DROP POLICY IF EXISTS <name> ON <table>;` first, or it errors on any
#    policy that's already present):
#   20260404000000_add_rls_policies — NOT idempotent — has bare CREATE POLICY
#   20260430010000_cart_last_activity_and_store_pages_rls — NOT idempotent — has bare CREATE POLICY
#   20260519100000_accounting_foundations — NOT idempotent — has bare CREATE POLICY
#   20260519210000_accounting_batch_2 — NOT idempotent — has bare CREATE POLICY
#   20260520000000_accounting_batch_3 — NOT idempotent — has bare CREATE POLICY
#   20260520020000_accounting_batch_4 — NOT idempotent — has bare CREATE POLICY
#   20260522000000_rls_for_8_missing_tables — NOT idempotent — has bare CREATE POLICY
#   20260602000000_fix_ai_usage_rls_bypass — idempotent (has DROP POLICY IF EXISTS)
#   20260609000000_complete_force_rls_coverage — idempotent (has DROP POLICY IF EXISTS)
#   20260615000000_add_bank_reconciliation — NOT idempotent — has bare CREATE POLICY
#   20260615000000_add_journal_line_fx_fields — NOT idempotent — has bare CREATE POLICY
#   20260615000000_barcode_scanning — NOT idempotent — has bare CREATE POLICY
#   20260615000000_multi_warehouse — idempotent (has DROP POLICY IF EXISTS)
#   20260615010000_add_staff_role_and_store_staff — NOT idempotent — has bare CREATE POLICY
#   20260616120000_add_store_locations — NOT idempotent — has bare CREATE POLICY
#   20260616210000_store_staff_write_policies — NOT idempotent — has bare CREATE POLICY
#   20260618000000_shipping_area_rate — NOT idempotent — has bare CREATE POLICY
#   20260621060000_store_staff_rls_tighten — idempotent (has DROP POLICY IF EXISTS)
#   20260622100000_product_daily_views — NOT idempotent — has bare CREATE POLICY
#   20260701010111_order_events — idempotent (has DROP POLICY IF EXISTS)
#   20260702170000_rls_close_denyall_tables — idempotent (has DROP POLICY IF EXISTS)
#   20260716000000_fix_product_daily_views_rls — idempotent (has DROP POLICY IF EXISTS)
#   20260716000100_store_staff_update_policy — idempotent (has DROP POLICY IF EXISTS)
#   20260721120000_customer_groups — idempotent (has DROP POLICY IF EXISTS)
#   20260722000000_answer_engine_check — idempotent (has DROP POLICY IF EXISTS)
#   20260722000100_gsc_daily_metric — idempotent (has DROP POLICY IF EXISTS)
#   20260722140000_promotions_and_coupon_targeting — idempotent (has DROP POLICY IF EXISTS)
#   20260722190000_slug_redirect_rls — NOT idempotent — has bare CREATE POLICY
#   20260906120000_product_bundles — idempotent (has DROP POLICY IF EXISTS)
#   20260911190000_merchant_api_keys — idempotent (has DROP POLICY IF EXISTS)
#    After re-applying, re-run step 5's two queries again to confirm the
#    counts now match prod before proceeding.

# 7. Cut over (repoint the app, or promote the branch in the console), then delete scratch branches.
neonctl branches delete restore-candidate --project-id "$PID" --org-id "$ORG"
```

⚠️ **Restore is destructive to writes made since the dump** — orders placed, products edited,
R2 uploads referenced from new rows — all lost. For FWB that's **per-tenant loss across every
store**. Prefer PITR (Layer 0) whenever the incident is inside the 7-day window; only fall back
to a dump when it isn't. Coordinate with the team before a production cutover.

---

## Erasure boundary — how long deleted PII survives in these backups

A `POST /auth/me/erase` request (GDPR Art. 17 and applicable GCC
data-protection law — see `docs/legal/gcc-data-protection.md`)
only mutates the LIVE database — it can't retroactively edit a backup that
was already taken. Full breakdown of the resulting persistence window
(PITR 7 days + dump retention 30 days below) and what that means for a
data-subject request: `docs/privacy/data-map.md` § "Deletion & backups".

## Retention — current & the GFS hardening step

Today: **flat 30 days** on both the local and R2 layers. For merchant data (orders, money, PII)
the next hardening step is **GFS (Grandfather-Father-Son)** tiering, which is what larger shops
run: keep **daily for 30d → weekly for 90d → monthly for 1yr**. R2 has no egress fees, so the
long tail is nearly free. Tracked as a follow-up; when implemented it lands as tiered lifecycle
rules on the R2 bucket + a `weekly`/`monthly` prefix in the backup workflow.

## Drill log — restore is TESTED, not just documented

Re-run this drill **quarterly** (and after any change to the backup pipeline). It touches only
throwaway branches; production (`main`) is never modified.

| Date       | Path                                                            | Result                                                    |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| 2026-07-06 | **PITR** — branched `main` to 15-min-ago                        | ✅ `stores=4 products=509 orders=68`, exact match to live |
| 2026-07-06 | **Dump restore** — 2026-07-05 local `.sql.gz` into fresh branch | ✅ 0 errors, restored in 309s, counts matched             |

To re-drill: run the Layer-0 restore block (steps 1–2, then `branches delete`) and the
dump-restore block (steps 1–3, verify counts, then `branches delete`). Both must end with only
`main` remaining: `neonctl branches list --project-id "$PID" --org-id "$ORG"`.

**Verify a dump is valid before trusting it:** `bash scripts/verify-dump.sh <file>.sql.gz`.
It exits 0 only for a dump that can actually restore — valid gzip, above the size floor, real
pg_dump header, ≥1 table, and **more data rows than tables**. Eyeballing `zcat < <file>.sql.gz |
head` shows the header but cannot tell a full dump from a schema-only one; that distinction is
the whole point. Its own tests (valid / empty / truncated / schema-only) live in
`scripts/verify-dump.test.sh` and run in CI via `tests/unit/db-backup-verify-dump.test.ts`.

A `.sql.gz.SUSPECT` file in the backup directory is a dump that FAILED that check, parked for
forensics by `scripts/backup-db.sh`. It is not a backup and is deliberately outside the
`*.sql.gz` glob the restore steps above use.
