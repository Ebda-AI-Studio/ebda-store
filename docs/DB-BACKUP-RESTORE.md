# Database backup, restore & disaster recovery

Canonical DR runbook for the Ebda Store Neon Postgres database. Three independent layers,
all **$0**. Every restore path below has been **drilled end-to-end** — see the drill log
at the bottom. When something goes wrong, start at the decision table.

## Which path do I use? (decision table)

| Situation                                                                              | Use                                             | RPO (data lost) | RTO (time to recover) |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- | --------------------- |
| Bad migration / accidental `DELETE` / app corrupted rows — **within the last 6 hours** | **Layer 0 — Neon PITR**                         | seconds         | ~2–5 min              |
| Same, but older than 6 hours                                                           | Layer 1/2 — dump restore                        | up to 24h       | ~5–10 min             |
| Neon project deleted / account lost / provider outage                                  | Layer 2 — R2 encrypted dump (`ebda-db-backups`) | up to 24h       | ~10–20 min            |
| Local Mac dead but need a dump                                                         | Layer 2 — R2 encrypted dump                     | up to 24h       | ~10–20 min            |
| Just need last night's data locally                                                    | Layer 1 — local `.sql.gz`                       | up to 24h       | ~5 min                |

**Default to Layer 0 (PITR).** It is the primary mechanism, near-zero data loss, and
never touches production while you verify. The dumps are the belt-and-suspenders for the
cases PITR can't cover (older than the window, or Neon itself is gone).

## The 4-layer strategy (what global companies do, and where we stand)

| Layer                      | RPO              | What it is                                                                                                   | Status                                                                                                             |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Continuous WAL / PITR**  | seconds–minutes  | Restore/branch to any timestamp. Neon does this natively via branch-at-timestamp                             | ✅ **6-hour window** (measured 2026-10-26: `history_retention_seconds = 21600`; the API refuses more on this plan) |
| **Periodic logical dumps** | = interval (24h) | `pg_dump` → independent storage; survives provider loss / account compromise / "someone deleted the project" | ✅ daily → local + R2                                                                                              |
| **3-2-1 rule**             | —                | 3 copies, 2 media, 1 off-site                                                                                | ✅ Neon (primary) + local Mac + R2                                                                                 |
| **GFS retention tiering**  | —                | daily 30d → weekly 90d → monthly 1yr (compliance long-tail)                                                  | ⚠️ flat 30d today (GFS is the next hardening step)                                                                 |

---

## Layer 0 — Neon Point-in-Time Recovery (PITR) · primary, near-zero RPO

Neon continuously retains WAL, so you can spin up an **isolated branch** of the database
as it existed at **any timestamp in the last 6 hours** — without touching production. This
is the fastest recovery for the common failure modes (a migration nuked a column, a script
mass-deleted rows, a bug corrupted data 20 minutes ago).

- **Window: 6 hours** (`history_retention_seconds = 21600`, project `lucky-truth-54548746`, measured with the Neon API on
  2026-10-26). This runbook used to say 7 days; that was never the live setting. Asking for 7 days
  (`PATCH /projects/<id>` with `{"project":{"history_retention_seconds":604800}}`) is **refused on the current plan**
  (21600 s is its maximum), so the window can only grow by changing plan. Anything older than 6 hours is NOT recoverable by
  PITR: use the off-machine dump below. Re-measure after any plan change and update this line.
- **Cost:** ~$0 — it's WAL already being written; branches are copy-on-write.

### Off-machine encrypted dump (the answer to "older than 6 hours")

`.github/workflows/db-backup.yml` runs nightly (02:43 UTC, GitHub-hosted, so it survives the Mac and the CI guest being
down): `pg_dump` 17 (custom format) of production, `scripts/ops/verify-db-dump.sh` (refuses an empty-ish dump), `age`
encryption to the public key in repo variable `EBDA_BACKUP_AGE_PUBLIC_KEY`, upload to the R2 bucket **`ebda-db-backups`**
(key `db/YYYY/MM/ebda-<ts>-<sha>.dump.age`; object lock 7 days; expires after 35 days), read-back compare, Telegram alert
on failure. The **private key is only in Ahmad's macOS Keychain** (service `ebda-db-backup-age-key`); nobody else, and no
CI job, can decrypt.

```bash
# restore the newest dump into a scratch Postgres
npx wrangler r2 object get ebda-db-backups/db/<YYYY>/<MM>/<file>.dump.age --file /tmp/x.dump.age --remote
security find-generic-password -s ebda-db-backup-age-key -w > /tmp/k && age -d -i /tmp/k -o /tmp/x.dump /tmp/x.dump.age && rm -f /tmp/k
pg_restore --no-owner --dbname "$SCRATCH_URL" /tmp/x.dump
```

### Restore with PITR

```bash
ORG=org-lingering-river-25973882
PID=crimson-king-40424588            # ebda-eu  (wbs-eu = spring-dew-80973306)
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

Central script `~/.claude/scripts/backup-all-neon.sh` (launchd `com.ebda.neon-backup`,
03:30 daily; runs on next wake if the Mac slept) gzip-dumps every Force Neon DB to
`~/Desktop/projects/_backups/<project>/`, keeps **30** (~1 month).

- **Location (Ebda Store):** `~/Desktop/projects/_backups/ebda/` (needs `NEON_API_KEY_EBDA`, a Whisky 11-org key, in `~/.whisky-services.env`)
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
the Ebda AI Studio CRM archived 30 consecutive nightly "successes" over five weeks against a
database that had already been wiped. Verification happens on the PLAINTEXT because an encrypted
blob cannot be inspected later without the key. A failed assertion **fails the job, fires the
Telegram alert, and uploads nothing** — a missing backup is loud, a worthless one is silent.

### Required repo secrets

`DATABASE_URL_DIRECT` (Neon direct owner url) · `BACKUP_ENCRYPTION_KEY` (`openssl rand -hex 32`
— **SAVE IT**, needed to decrypt/restore; also stashed at `~/.claude/.<project>-backup-key`) ·
`R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET=databasebackup`.

---

## Restore from a dump (Layer 1 or 2)

Use when PITR can't cover it (older than 6 hours, or Neon itself is gone). **Always restore
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
ls -lt ~/Desktop/projects/_backups/ebda/*.sql.gz
DUMP=~/Desktop/projects/_backups/ebda/<chosen>.sql.gz
#    …or fetch + decrypt an R2 copy:
#    KEY=$(cat ~/.claude/.ebda-store-backup-key)
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
#    then restore in a single transaction (all-or-nothing; ~5 min for Ebda Store from Frankfurt).
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
R2 uploads referenced from new rows — all lost. For Ebda Store that's **per-tenant loss across every
store**. Prefer PITR (Layer 0) whenever the incident is inside the 6-hour window; only fall back
to a dump when it isn't. Coordinate with the team before a production cutover.

---

## Cloudflare storage (StoreDO + D1): the DR path after the Neon cutover (G8, INFRA-CF-1)

Applies once a store is served from its StoreDO (flag `STORE_DO_ENABLED_IDS`); until then Layers 0 to 2 above are the DR. Three copies on two providers' worth of failure domains:

| Copy               | What                                                                                                                                                    | When                                                                                    | Where                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. DO alarm export | every StoreDO table as NDJSON + `manifest.json` (rows, sha256), read back and re-verified after the write (`verifyWritten`)                             | nightly, per store (alarm armed by the sweep)                                           | R2 `ebda-private/store-do-backups/<storeId>/<yyyy-mm-dd>/` |
| 2. D1 export       | every table of each bound D1 (`PLATFORM_DB`, `IDENTITY_DB`) + `schema.sql` + manifest                                                                   | nightly 03:00 UTC Cron (`backup-sweep`, `apps/api/src/cf/ops/backup-sweep.ts`)          | R2 `ebda-private/d1-backups/<db>/<day>/`                   |
| 3. Mac pull        | rclone copy of all of the above, re-verified against the manifests (line counts and sha256), row-collapse check against the previous day, keeps 30 days | nightly, launchd job `ebda-cf-backup` (`ops/backup-ebda-cloudflare.sh` in the ops repo) | `~/Desktop/projects/_backups/ebda-cloudflare/<day>/`       |

Native extras that are NOT a substitute: StoreDO point-in-time recovery (30 days, `getBookmarkForTime`) and D1 Time Travel (30 days). They die with the Cloudflare account; copy 3 is the one that survives an account loss.

**Detection.** The sweep (a) re-arms every store's alarm, (b) alerts P1 when a store has no manifest for yesterday (an alarm that never fired cannot report itself), (c) alerts when any D1 export fails its count assert, and (d) writes `ops-reports/backup-sweep/<day>.json`. The Mac pull alerts through `backup_alert` on a missing or failed day and `os-selftest` flags it after 36 h.

**Restore a store (StoreDO).** `stub.restoreFrom(<sourceStoreId>, <yyyy-mm-dd>)` on a fresh, empty StoreDO id: it loads the NDJSON, re-exports with the same canonical serialization and returns per-table `{rows, sha256, ok}`; all `ok` is the pass condition. From the Mac copy, upload the day folder back to R2 first (`rclone copy <local day> R2:ebda-private/store-do-backups/...`).

**Restore a D1 database.** Create an empty D1, then `restoreD1FromBackup(name, day, r2, db)` (same module) which executes `schema.sql`, loads each NDJSON in batches of 50 and re-exports; pass = every table `ok: true`. For a point-in-time loss inside 30 days prefer `wrangler d1 time-travel restore <db> --timestamp=<iso>` (no data movement).

**Drill log (Cloudflare storage)**

| Date       | Path                                                                                                                                                                       | Result                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-24 | StoreDO restore from R2 into a fresh DO (phase 0, live on `storedemo-souq`)                                                                                                | all 7 tables equal rows and checksums (`docs/plans/2026-10-24-cf-phase0-go-no-go.md`)                                                                                                                        |
| 2026-10-24 | D1 export, then restore into an empty D1, then re-export (local workerd, `apps/api/workers-do/backup-sweep.test.ts` "RESTORE DRILL", runs in CI job `workerd-integration`) | users + passkeys (BLOB column included): rows and sha256 equal; second restore into the non-empty target refused                                                                                             |
| NOT YET    | Live D1 databases and the Mac pull against real R2                                                                                                                         | `ebda-platform` / `ebda-identity` do not exist in production yet (phases 1 and 2), and the Mac pull needs the read-only R2 token described in `ops/backup-ebda-cloudflare.sh`. Drill both before the cutover |

## Erasure boundary — how long deleted PII survives in these backups

A `POST /auth/me/erase` request (GDPR Art. 17 and applicable GCC
data-protection law — see `docs/privacy/data-map.md`)
only mutates the LIVE database — it can't retroactively edit a backup that
was already taken. Full breakdown of the resulting persistence window
(PITR 6 hours + dump retention 30 days below) and what that means for a
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
