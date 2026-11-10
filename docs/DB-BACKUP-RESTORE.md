# Database backup, restore & disaster recovery

> **2026-11-05: Postgres/Neon is GONE** (API `/health` `postgres: removed`; Neon project deleted; `db-backup.yml` disabled). Production data now lives in **D1 `ebda-platform`** and **one StoreDO (SQLite Durable Object) per store**. Everything below the line "Legacy Neon runbook" describes the retired Postgres layers and is kept only as history. Ruling NZ-BACKUP-1. The Neon **final dump** under `ebda-db-backups/final/` has no expiry and is not touched by anything here.

## Which path do I use? (Cloudflare era)

| Situation                                                             | Use                                                                                     | RPO         | Notes                                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad migration / bad write in D1, within 30 days                       | **D1 Time Travel** (`wrangler d1 time-travel restore`)                                  | seconds     | in place; prints the bookmark to undo it                                                                                                                      |
| Bad write in one store's DO, within 30 days                           | **DO point-in-time recovery** (SQLite storage bookmarks)                                | seconds     | platform feature; NOT VERIFIED here: no operator route in this repo calls `storage.onNextSessionRestoreBookmark` yet, so it needs a one-off admin route first |
| Older than 30 days, or both D1 and a DO damaged                       | **R2 dumps** `cf/` (this document, "Real recovery")                                     | up to 24 h  | needs the age private key (Ahmad's Keychain, `ebda-db-backup-age-key`)                                                                                        |
| Cloudflare ACCOUNT lost (the R2 backup bucket is in the same account) | **Mac copy** `~/Desktop/projects/_backups/ebda-cf-encrypted/` (`days/<day>/`, `media/`) | up to ~30 h | same artifacts + the same age key; restore with `restore-drill.mjs --dir` laid out from it (see "Off-account copy")                                           |
| "Does the backup actually work?"                                      | the restore drill                                                                       | n/a         | weekly fixture in CI; real one by the controller                                                                                                              |

## What is backed up (nightly 02:17 UTC, `.github/workflows/cf-backup.yml`)

1. **D1 `ebda-platform`**: `wrangler d1 export --remote` (SQL).
1. **D1 `ebda-identity`** (merchant/staff credentials, MFA, passkeys, sessions; Ruling ICEBERG-BK-1, added 2026-11-10): same export, artifact `d1-ebda-identity.sql.gz.age`, encrypted with the same age public key. The drill restores it into a **scratch** local D1 and compares every table's row count + digest; a v2 manifest without it fails the drill.
1. **Every StoreDO store** (`stores.storage_backend = 'do'`): the read-only, bearer-checked `POST /cutover/stores/<id>/__export` (paged by primary key, 2000 rows a page, same row shape `__import` takes) after `GET .../__tables`. The bearer is `BACKUP_EXPORT_SECRET`, which opens only `__export`/`__tables`/`__fks`/`__status`.
1. Each artifact is **gzip -9, then age-encrypted** (public key only on the runner), uploaded, **read back and sha256-compared**, and listed in a **manifest** with raw, compressed and encrypted sizes, row counts and a content digest per table.
1. Layout in bucket `ebda-db-backups`:

| Prefix                             | Written       | Kept             | Lifecycle rule              |
| ---------------------------------- | ------------- | ---------------- | --------------------------- |
| `cf/daily/<YYYY-MM-DD>/`           | every night   | 7 days           | `cf-daily-7d`               |
| `cf/weekly/<YYYY-MM-DD>/`          | Sundays (UTC) | 4 weeks          | `cf-weekly-28d`             |
| `cf/monthly/<YYYY-MM-DD>/`         | the 1st       | 3 months         | `cf-monthly-93d`            |
| `cf/ledger.json`, `cf/latest.json` | every night   | overwritten      | none (outside the prefixes) |
| `final/`, `db/`                    | legacy Neon   | `final/` forever | untouched                   |

Each folder holds `d1-ebda-platform.sql.gz.age`, `d1-ebda-identity.sql.gz.age`, `do-<storeId>.ndjson.gz.age` and `manifest.json`. **Skip-if-unchanged**: when an artifact's raw sha256 equals the last daily's, the daily manifest points at the earlier object (`reused: true`) and nothing is uploaded; that reference is used only while the target is at most 4 days old, so it can never outlive its own expiry. Weekly and monthly folders are always full uploads of their own.

**Size guard** (fails the run, so `notify-failure` pages Telegram): one run uploading more than 2x the median of the last 7 runs (ignored below 1 MiB), or the estimated `cf/` total (from `cf/ledger.json`, an estimate because wrangler cannot list a bucket) above `EBDA_BACKUP_CF_CAP_BYTES` (default 1 GiB). The step summary prints raw, compressed, uploaded and cf/ total sizes every night.

**Footprint**: worst case is about 14 times the compressed size of one night (7 daily + 4 weekly + 3 monthly), fewer when nothing changes. Fixture measurement (measured, a small synthetic store): 82 KB raw to 15 KB gzip, 5.5x. Production raw sizes are NOT measured yet (no production access in the build session); the first nightly summary and the first drill print them. R2 costs $0.015 per GB-month after the first 10 GB, so a 700 MB compressed night is about 10 GB at worst and costs $0. The default 1 GiB cap therefore alarms when one compressed night passes roughly 75 MB: raise the variable if the real number is larger and still cheap.

### R2 `ebda-media` (Ruling ICEBERG-BK-2, added 2026-11-10)

After the databases, the same job copies **only new or changed** objects of `ebda-media` (compared by etag against `media/manifest.json`) over the Cloudflare REST API, age-encrypts each (expense receipt photos live in this bucket), uploads it to `media/objects/<etag>/<key>.age`, reads it back (sha256) and records key, etag, size and backup key in `media/manifest.json` (checkpointed every 25 copies). A source object that disappears is marked `deletedAt` and its copy is kept; an overwritten key keeps its older copies under `previous`. `media/` has **no lifecycle rule**. Size guard: `EBDA_BACKUP_MEDIA_CAP_BYTES` (default 10 GiB). Measured 2026-11-10: 259 objects, 23.6 MB. The REST quota is 1200 requests / 5 min shared with the job's wrangler calls (measured from the response headers), so the client sleeps to stay at 2 requests/s and honours `Retry-After` on a 429.

Restore one image: fetch `media/objects/<etag>/<key>.age`, `age -d -i <identity> > file`, `wrangler r2 object put ebda-media/<key> --file file --remote`.

### Off-account copy (Ruling ICEBERG-BK-3)

`ebda-db-backups` lives in the **same** Cloudflare account as production, so it does not survive losing the account. `scripts/ops/pull-cf-backups.mjs` (launchd `app.ebda.cf-backup-pull`, daily 08:05 local, installed by `bash scripts/ops/install-cf-backup-pull.sh`, log `~/Library/Logs/ebda-cf-backup-pull.log`) pulls the newest daily set and the whole `media/` mirror over api.cloudflare.com into `~/Desktop/projects/_backups/ebda-cf-encrypted/` (local, not iCloud), checks every file's sha256 against the manifest, fails when the newest backup is more than 2 days old or lacks `d1-ebda-identity`, keeps the newest **30** day folders (hard links into content-addressed `objects/`, so unchanged artifacts cost nothing) and never prunes `media/`. Files stay encrypted on the Mac. It needs a Cloudflare API token with **Workers R2 Storage: Read** only, in the Keychain as `ebda-r2-backup-read`. To restore from it: lay a day folder out as `cf/daily/<day>/` + `cf/latest.json` in a directory and run `restore-drill.mjs --dir <that directory>`.

The older Worker sweep (`ebda-private/{store-do-backups,d1-backups}`, platform D1 + StoreDOs only, no identity) is still pulled by `backup-ebda-cloudflare.sh` (force-ai-foundation, launchd `com.forceai.ebda-cf-backup`, 07:15).

## Real recovery (restore production from these backups)

Prerequisites: the age private key (`security find-generic-password -s ebda-db-backup-age-key -w`; a multi-line secret comes back as **hex**: the scripts decode it, by hand it is `... | xxd -r -p`), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` with R2 read, `wrangler`. Timings below are from the fixture drill (3.6 s for a 132-table store plus the D1 schema on a laptop); real timings for the full data set go in the drill log below after the first real drill.

**Step 0 - prove the backup first (read-only on production).** `node scripts/ops/restore-drill.mjs` (newest daily; `--tier weekly|monthly --day YYYY-MM-DD` for older). It fetches, decrypts, checks every sha256, restores D1 into a local D1 and every store into a local StoreDO through `__import`, boots the real API Worker on workerd and calls the public endpoints, and prints one PASS/FAIL report. Then `--extract <dir>` writes the verified plaintext artifacts for the steps below:

```bash
node scripts/ops/restore-drill.mjs --extract ./restore --tier monthly --day 2026-11-01
```

**A. D1 into a NEW database (provider-loss or "I do not trust the old one")**

The D1 artifact is **order-safe**: `wrangler d1 export` writes tables alphabetically with rows interleaved, so a child row can precede its parent table and a plain `wrangler d1 execute --file` fails with `no such table: main.stores` (the first real drill, 2026-11-05). The backup now rewrites the artifact (`normalizeD1Sql`: `defer_foreign_keys`, all CREATE TABLEs parents-first, then rows, then indexes/triggers) and the drill and `--extract` normalize older artifacts too, so the extracted `.sql` always loads with the plain command below. Verified with real `wrangler d1 execute --local`: raw failed, normalized ran 131 commands.

```bash
npx wrangler d1 create ebda-platform-restore
npx wrangler d1 execute ebda-platform-restore --remote --file ./restore/d1-ebda-platform.sql
# point the API at it: set repo variable EBDA_PLATFORM_D1_ID to the new id, then
gh workflow run cf-api-deploy.yml
# verify: GET https://api.ebda.app/health (storage_backend counts) and one public store
```

**A2. D1 `ebda-identity` into a NEW database** (merchant sign-in lost; the extract writes it order-safe too)

```bash
npx wrangler d1 create ebda-identity-restore
npx wrangler d1 execute ebda-identity-restore --remote --file ./restore/d1-ebda-identity.sql
# point apps/accounts at it: database_id in apps/accounts/wrangler.jsonc (binding DB), redeploy accounts, then sign in once
```

**B. D1 in place (within 30 days, no dump needed)**

```bash
npx wrangler d1 time-travel info ebda-platform --timestamp <ISO time before the damage>
npx wrangler d1 time-travel restore ebda-platform --timestamp <ISO time>   # prints the bookmark that undoes it
```

**C. A StoreDO from its dump** (the DO is emptied and re-imported through the same path the cutover used, then verified against the manifest; a new namespace is the same command against a Worker that has the new class):

```bash
export CUTOVER_IMPORT_SECRET=<24+ chars, set as a Worker secret for the window, deleted afterwards>
node scripts/ops/restore-store-do.mjs --dir ./restore --store <store uuid> \
  --api-url https://api.ebda.app --wipe --i-understand-this-writes-production
```

The replay goes **parents first** (order from the target's own schema, `GET __fks`) because a StoreDO enforces foreign keys while importing (measured 2026-11-05: `PRAGMA foreign_keys = OFF` has no effect there, drill 3 failed `FOREIGN KEY constraint failed`); a self-referencing table (`categories`, `accounts`, `journal_entries`) is sent parent-row-first in one page. A table in the backup that the target schema lacks is named, all at once, before any write. The backup leaves out `onesignal_subscriptions` (moved to D1, Ruling NZ-C-11; older StoreDOs still hold a stale copy) and records its row count under `skippedTables` in the manifest.

Rehearse C against local workerd first (`--api-url http://127.0.0.1:8798`, no extra flag). After C: `GET /cutover/stores/<id>/__status` and a storefront read; re-seal if the store was sealed.

## Controller runbook: turning the nightly backup on (production changes; the build session ran none)

1. Pick the Worker secret: `openssl rand -hex 32`; `cd apps/api && npx wrangler secret put BACKUP_EXPORT_SECRET`; the same value into GitHub environment `production`: `gh secret set BACKUP_EXPORT_SECRET --env production --repo Ebda-AI-Studio/ebda-store`.
2. Confirm vars `EBDA_BACKUP_AGE_PUBLIC_KEY` and `CLOUDFLARE_ACCOUNT_ID` and secret `CLOUDFLARE_API_TOKEN` (R2 write + D1 read) exist in environment `production` (the deleted `db-backup.yml` used them too). Optional var `EBDA_BACKUP_CF_CAP_BYTES`.
3. Deploy the API (`gh workflow run cf-api-deploy.yml`; the `__export` action ships in this PR). Check `/health` commit equals main.
4. Set retention: `bash scripts/ops/r2-lifecycle-cf.sh` (prints), then `--apply`, then `npx wrangler r2 bucket lifecycle list ebda-db-backups` and confirm `final/` has NO rule.
5. `gh workflow run cf-backup.yml`; read the step summary (sizes) and confirm `cf/latest.json` exists.
6. First real drill on that backup: `node scripts/ops/restore-drill.mjs --target api` (about 1 minute plus the API build step). Record the result and timings in the log below. Fix whatever the API checks report before trusting them.
7. Workflow files changed: the PR needs the `deploy-change` label (the controller adds it).

## Drill log

| Date       | Backup                                                         | Result                                                                                                                                         | Time  |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 2026-11-05 | local fixture (workerd, 132-table store, real platform schema) | D1 31/31 tables and DO 132/132 tables equal; replay through the real API Worker passed; public API checks not green on the fixture (see below) | 3.6 s |

Fixture API result, stated plainly: against the fixture the real Worker answered `categories` 200, but `store resolve` 404 and `products` 500 (`POSTGRES_REMOVED: store.findUnique / storeFeature.findMany`: a path in this branch's API still reaches Prisma for that request), and the admin read is skipped by design. Whether that is a fixture artifact or a real unported path is NOT settled; the first real drill answers it. Do not call the API stage proven until it passes on real data.

## Legacy Neon runbook (retired 2026-11-05, history only)

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

`.github/workflows/db-backup.yml` (DELETED 2026-11-05, Ruling NZ-17-BACKUP-1; history only) ran nightly (02:43 UTC, GitHub-hosted, so it survives the Mac and the CI guest being
down): `pg_dump` 17 (custom format) of production, `scripts/ops/verify-db-dump.sh` (refuses an empty-ish dump), `age`
encryption to the public key in repo variable `EBDA_BACKUP_AGE_PUBLIC_KEY`, upload to the R2 bucket **`ebda-db-backups`**
(key `db/YYYY/MM/ebda-<ts>-<sha>.dump.age`; object lock 7 days; expires after 35 days), read-back compare, Telegram alert
on failure. The **private key is only in Ahmad's macOS Keychain** (service `ebda-db-backup-age-key`); nobody else, and no
CI job, can decrypt.

```bash
# restore the newest dump into a scratch Postgres
npx wrangler r2 object get ebda-db-backups/db/<YYYY>/<MM>/<file>.dump.age --file /tmp/x.dump.age --remote
node scripts/cf/lib/keychain.mjs ebda-db-backup-age-key --age > /tmp/k && age -d -i /tmp/k -o /tmp/x.dump /tmp/x.dump.age && rm -f /tmp/k
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

`.github/workflows/db-backup.yml` (DELETED, history only) ran daily 03:50 UTC (+ `workflow_dispatch`): `pg_dump 17`
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

Applies once a store is served from its StoreDO (D1 flag `stores.storage_backend`); until then Layers 0 to 2 above are the DR. Three copies on two providers' worth of failure domains:

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
