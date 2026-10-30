# Cutover runbook: Postgres (Neon) to Cloudflare (StoreDO + D1)

INFRA-CF-1 phase 5. Rulings: CUTOVER-1 (one batch, shrunken shadow, Postgres read-only fallback for 7 days), CUTOVER-2 (tooling design), CUTOVER-3 (write freeze), CF-JOBS-1 (jobs and DO stores), CF-JOBS-2 (the freeze reaches every writer). Plan: `business/ebda/plans/2026-10-28-store-on-cloudflare-detailed.md` (phases 4, 5, 7.2).

Production today (Ruling CUTOVER-1, measured on the 2026-10-25 dump): 6 stores (5 `storedemo*` + `qa-walk-store-1010`), 19 orders, 6 users, 26 MB. No real merchants. The cutover is ONE batch for all stores, never store by store.

**This runbook is executed only on the controller's explicit go, after phases 2, 3 and 6 are merged and deployed.** Nothing here has been run against production; section 11 records exactly what was rehearsed and what was not.

## 1. Roles and who to page

| Who                          | Role                                                               | How                                                                                            |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Ahmad                        | Owner, the only human operator, gives the go and the no-go         | Telegram (bot `@EbdaAIStudiobot` alert chat); must be awake and reachable for the whole window |
| Ebda controller session      | Runs the sequence below, owns the decision log                     | the session that holds this runbook                                                            |
| Cutover agent                | Tooling in `scripts/cf/` and `packages/cf-migrate/`                | ask the controller; do not hand-edit data to "fix" a mismatch                                  |
| Job freeze (`WRITES_FROZEN`) | Stops every background writer: crons, queues, Workflows, DO alarms | the controller (Worker var + deploy); Ahmad has no dashboard step (Inngest is removed, G5-3)   |

Page Ahmad immediately (P0, `docs/INCIDENT.md`) when: verify does not print `PASS`, a smoke step fails after the flip, `/health` disagrees with the flag, or a rollback itself does not restore service.

## 2. Inputs and secrets

| Name                    | Value / where                                                                                            | Notes                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API`                   | `https://api.ebda.app`                                                                                   |                                                                              |
| `CFG`                   | the wrangler config that binds D1 `ebda-platform` (`apps/api/wrangler.jsonc` once phase 2 lands)         | personal/Whisky 11 Cloudflare account (`as.montaseer@gmail.com`)             |
| `CUTOVER_IMPORT_SECRET` | 24+ random chars, `openssl rand -hex 24`; set as an `ebda-api` secret AND exported in the operator shell | rotated at the end (section 10)                                              |
| `CUTOVER_DO_URL`        | `$API` (the Worker routes `/cutover/stores/<id>/\_\_import                                               | \_\_verify                                                                   | \_\_seal | \_\_status`) | the Worker (`apps/api/src/cf/cutover.ts`) checks the bearer with `authorizeCutover` before the DO sees the request; routes: `__import`, `__verify`, `__seal`, `__status`, `__unseal`, plus `__rebase`/`__diff` (used by `flip-backend.mjs --to pg`) |
| `CUTOVER_PG_URL`        | the **scratch** database the window dump was restored into (section 5.2)                                 | never a writable production URL                                              |
| Window dump             | `pg_dump` of the Neon DIRECT url taken at the start of the read-only window                              | same recipe as `~/.claude/scripts/backup-all-neon.sh`; needs `pg_dump` >= 17 |

Read-only guarantee: `scripts/cf/lib/pg.mjs` forces the session read-only three ways and refuses a `*.neon.tech` host without `--allow-prod-read`. Reading production Neon directly (`--allow-prod-read`) is allowed as a fallback; the default path reads a scratch restore so the run is byte-for-byte the rehearsed one.

## 3. Rehearsal (do this in the 24 h before the real window; also the dry run for phase 4.3)

```bash
# scratch Postgres: own database on the shared PG17 (:54417), never the shared 'postgres' db
createdb -h localhost -p 54417 -U postgres ebda_cutover_rehearsal
gunzip -c ~/Desktop/projects/_backups/ebda/<newest>.sql.gz | psql -h localhost -p 54417 -U postgres -q -d ebda_cutover_rehearsal
export CUTOVER_PG_URL=postgres://postgres@localhost:54417/ebda_cutover_rehearsal
bash scripts/cf/rehearse-cutover.sh <workdir>     # local workerd + local D1, prints the timing table
dropdb -h localhost -p 54417 -U postgres ebda_cutover_rehearsal
```

The script fails on the first non-equal table. It runs: D1 schema apply, dry run, platform to D1, all stores to StoreDO, verify, same-batch re-run (must be all "already applied"), new-batch re-run (upsert), verify again, flag flip with seal, import after seal (must be refused 423), rollback flip. A rehearsal older than 24 h, or on a dump older than the newest backup, does not count.

## 4. Go / no-go checklist (all must be yes)

| #   | Check                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phases 2, 3, 6 merged AND deployed: `curl -s $API/health` shows `commit` = tip of `main` and `storage_backend` counts                                                                                                                                                                                                                                                  | paste the health JSON                                                                                                                          |
| 2   | D1 `ebda-platform` exists remotely with all migrations applied                                                                                                                                                                                                                                                                                                         | `npx wrangler d1 migrations list ebda-platform --remote -c $CFG` shows none pending                                                            |
| 3   | `stores.storage_backend` exists in D1 and the flag writer invalidates the edge cache (plan task 2.4; NEVER-stale class)                                                                                                                                                                                                                                                | `npx wrangler d1 execute ebda-platform --remote -c $CFG --command "SELECT name FROM pragma_table_info('stores') WHERE name='storage_backend'"` |
| 4   | The StoreDO mounts `handleStoreAdmin`; the `ebda-api` Worker checks `authorizeCutover` (constant-time bearer) BEFORE the DO sees the request; `CUTOVER_IMPORT_SECRET` is set on `ebda-api` (unset = 503, fail closed, `[cutover] refused` in the logs); an unauthenticated POST to `/cutover/stores/<id>/__import` returns 401 (a 503 means the secret is NOT set yet) | `curl -s -o /dev/null -w '%{http_code}' -X POST $API/cutover/stores/00000000-0000-0000-0000-000000000000/__import` prints 401                  |
| 5   | Identity is already on D1 `ebda-identity` (accounts.ebda.app); users, sessions, passkeys are NOT migrated by these scripts                                                                                                                                                                                                                                             | `curl -sI https://accounts.ebda.app` 200; `verify-store.mjs` lists `users` etc. as "elsewhere", not as a gap                                   |
| 6   | Rehearsal (section 3) on the newest dump passed within 24 h: `712/712`-style line ending `PASS`                                                                                                                                                                                                                                                                        | the rehearsal workdir log                                                                                                                      |
| 7   | Fresh backups: today's `~/Desktop/projects/_backups/ebda/*.sql.gz` is non-trivial in size and `pg_restore`/`psql` restores; R2 DO backup alarm (phase 6.1) has run for the demo store                                                                                                                                                                                  | `ls -l`, restore test from the rehearsal                                                                                                       |
| 8   | Sentry + UptimeRobot (`/health`) are alerting to Telegram                                                                                                                                                                                                                                                                                                              | send the test alert                                                                                                                            |
| 9   | `RULED_DROPPED_COLUMNS` reviewed against the window dump: no new column with data in Postgres that the schema drops                                                                                                                                                                                                                                                    | the migrate dry run prints `dropped` as ruled only                                                                                             |
| 10  | No deploy or migration is in flight; `container list` shows none of this work's containers; host disk < 90% full                                                                                                                                                                                                                                                       |                                                                                                                                                |
| 11  | Erasure on the Cloudflare path is store-scoped (Ruling CI-8 residual, PR #228): the DO-side erasure trigger calls `apps/api/src/lib/ci/erase.ts` (store-scoped, proof-gated), NOT `ciSurface.eraseSubject`, which erases by buyer key across ALL stores                                                                                                                | `packages/cf-migrate/test/erasure-ci.test.ts` green once #228 is merged; until then this row is a NO-GO for any real subject erasure           |
| 12  | Ahmad has said go in this session                                                                                                                                                                                                                                                                                                                                      | the message                                                                                                                                    |

Any "no": stop, fix, rehearse again. Do not shorten the checklist.

## 5. The read-only window (T0)

Everything between 5.1 and 7 happens inside the window. Target length from the rehearsal: well under 10 minutes of tool time for this data volume; plan 60 minutes for the humans.

### 5.1 Freeze writers

1. Set `WRITES_FROZEN=1` on `ebda-api` (var in `apps/api/wrangler.jsonc` or the dashboard, then `gh workflow run cf-api-deploy.yml` / `wrangler deploy`). This ONE variable freezes every writer (Ruling CF-JOBS-2, replaces "pause Inngest"): HTTP answers 503 `READ_ONLY_WINDOW` to every non-GET; Cron Triggers stand still (a sweep tick is skipped, a rarer job is parked); every queue consumer (email, sms, jobs, CI, WhatsApp store events, DLQs) re-sends or retries its messages instead of running; Workflow instances sleep before every step; StoreSchedule alarms keep their due time and re-arm 5 minutes out. Nothing is dropped: all of it runs after the thaw. Deploy takes effect within the deploy; instances already between steps stop at their next step.
2. Let in-flight work drain: wait 2 minutes (the longest step is bounded by its 15 minute timeout, but a step that was already running when the flag landed is at most one per instance), then check the window is quiet: Cloudflare dashboard, Workers & Pages, `ebda-jobs` Workflow instances show `running` only briefly, and `wrangler tail ebda-api --search "write freeze"` prints the park lines (`[cron] write freeze`, `[jobs] write freeze: run parked`, `[freeze] batch parked`).
3. Prove the HTTP freeze: `curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/v1/public/<any write path>` returns 503, and a GET returns 200.
4. Record the clock: `T0=$(date -u +%FT%TZ)`.

### 5.2 Final dump and scratch restore

```bash
URL=$(neonctl connection-string --project-id <ebda project> --role-name neondb_owner)   # DIRECT url, read
pg_dump --no-owner --clean --if-exists "$URL" | gzip > ~/Desktop/projects/_backups/ebda/cutover-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
createdb -h localhost -p 54417 -U postgres ebda_cutover_final
gunzip -c <that file> | psql -h localhost -p 54417 -U postgres -q -d ebda_cutover_final
export CUTOVER_PG_URL=postgres://postgres@localhost:54417/ebda_cutover_final
```

Neon is only READ (`pg_dump`). Never run DDL/DML on it. Record counts from the dump and compare with the production pre-check numbers (stores, orders, users): `psql ... -Atc "select count(*) from stores"` etc.

### 5.3 Dry run on the real dump

```bash
node scripts/cf/migrate-store-to-do.mjs --all --dry-run
```

Must finish without `FAILED`, list only ruled dropped columns, and report 0 UNPLACED rows except the ones already accepted (see section 11). Any unexpected non-null in a dropped column or unplaced row: stop, escalate to Ahmad.

## 6. Run order

Always in this order (platform first, so `entity_index` and the directory exist before a DO serves):

```bash
export CUTOVER_DO_URL=$API CUTOVER_IMPORT_SECRET=<secret> BATCH=cut-$(date -u +%Y%m%dT%H%MZ)
D1=(--d1 ebda-platform --d1-target remote --d1-config $CFG)

node scripts/cf/migrate-platform-to-d1.mjs "${D1[@]}" --archive-dir ~/Desktop/projects/_backups/ebda/analytics-$BATCH
node scripts/cf/migrate-store-to-do.mjs --all --batch $BATCH --report /tmp/migrate-$BATCH.json
node scripts/cf/verify-store.mjs --all "${D1[@]}" --report /tmp/verify-$BATCH.json
```

- Analytics tables are archived, not imported (Ruling CUTOVER-2 f). Product embeddings are rebuilt from Product by the indexer after the flip.
- A failed page is safe to retry with the SAME `--batch`: applied pages are skipped, a half-applied page rolled back with its transaction.
- Do NOT edit Postgres or the DO by hand to make verify pass.

## 7. Verify (the gate)

`verify-store.mjs --all` must end with a line like `712/712 tables equal across 7 target(s) ... PASS` and exit 0. It checks, per table on both sides: row count and a sha256 over every migrated column; per store: Decimal/date/boolean/list aggregates recomputed in Postgres with different SQL; `PRAGMA foreign_key_check` is 0; Postgres tables nobody reads are empty or ruled. `FAIL` or any `MISMATCH`/`SEMANTIC` line is a no-go: leave the flag alone, go to section 9 (nothing has been flipped yet, so the rollback is just un-freezing).

Then re-check the window really was quiet: re-run the three counts (stores, orders, users) against production Neon read-only (`psql "$URL" -Atc ...`); they must equal the dump's. A difference means a write slipped through the freeze: stop and ask Ahmad.

## 8. Flag flip, smoke, shadow compare

### 8.1 Before-snapshot

```bash
node scripts/cf/shadow-snapshot.mjs snap --api $API --stores storedemo,storedemo-dahab,storedemo-jasmine,storedemo-lamma,storedemo-souq,qa-walk-store-1010 --out /tmp/shadow-before
```

(Arabic and English, 7 public GETs per store; qa-walk may legitimately 404 some.)

### 8.2 Flip (seals the DOs first)

```bash
node scripts/cf/flip-backend.mjs --to do --all "${D1[@]}" --verify-report /tmp/verify-$BATCH.json --health-url $API/health --yes
```

It refuses without a passing verify report younger than 60 minutes that covers every store, seals each StoreDO (imports are closed for good), writes `stores.storage_backend='do'`, and waits until `/health` `storage_backend` shows the new counts. Take the time stamp: this is when rollback stops being lossless (section 9).

### 8.3 Unfreeze reads and writes

Remove `WRITES_FROZEN` (or set `0`) and redeploy: the parked messages, Workflow instances and alarms run on their own within 5 minutes, in the order they were parked (a parked daily cron runs once, a skipped sweep tick is replaced by the next tick). Run the smoke below once the backlog drains; `JOBS_ON_DO=1` is set in the same deploy that flips the first store (Ruling CF-JOBS-1), never before.

### 8.4 Smoke (NEVER complete a purchase)

1. `curl -s $API/health | jq` shows `commit` = main tip, `storage_backend` = `{"do": 6}`.
2. Arabic storefront: open `https://storedemo.ebda.app` in the Arabic locale (RTL, Arabic copy, product images, prices in piastres rendered as EGP). Open a product page and a category page.
3. Admin: sign in at `https://store.ebda.app` as the demo owner, open products, orders (the 19 migrated orders are listed with the right totals), settings.
4. Guest cart: add a product to a cart as a guest and view the cart. Stop at the cart. Do not enter checkout payment; do not place an order.
5. Cross-store isolation: a store A request with store B's id gets 404/403 (the isolation test in CI covers it; one manual curl is enough).
6. Sentry: no new issue in the 10 minutes after the flip.

### 8.5 Shadow compare (Ruling CUTOVER-1, shrunken)

```bash
node scripts/cf/shadow-snapshot.mjs snap --api $API --stores <same list> --out /tmp/shadow-after
node scripts/cf/shadow-snapshot.mjs diff /tmp/shadow-before /tmp/shadow-after
```

Exit 0 (`0 differ`) required. A diff is triaged: a volatile field is added to `--ignore` with a written reason; anything else is a bug and triggers rollback (section 9). Then watch Sentry and `/health` for 2 hours (the "live diffs" half): any new issue touching a store route or a StoreDO exception is a diff to explain. Decision to keep the flip is Ahmad's after the 2 hours.

## 9. Rollback (Audit DB-1: it never drops live writes silently)

`flip-backend.mjs --to do` seals every StoreDO and records a per-row baseline (sha256 of every column) of each DO and of D1. `--to pg` diffs the live side against those baselines first and prints the changed rows per table:

| Situation                                                                                                                                | Action                                                                                                                                                                                                                                                                                                                                                                                                                                       | Data cost                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Failure before 8.2 (dry run, migrate, verify, window check)                                                                              | remove `WRITES_FROZEN` (parked work resumes by itself), drop the scratch DB. Nothing was flipped; production Postgres was only read.                                                                                                                                                                                                                                                                                                         | none                           |
| Failure after 8.2, no live write since the flip                                                                                          | `node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --health-url $API/health --yes`. It prints "loses nothing", flips the flag and waits for `/health` to agree.                                                                                                                                                                                                                                                                      | none                           |
| Live writes exist (orders, payments, stock, settings...)                                                                                 | (a) REPLAY, preferred: add `--replay-pg-url <owner url of the Neon DIRECT endpoint> --allow-prod-write`. The script writes every added, changed and deleted row back into Postgres in ONE transaction, then compares Postgres to the live side table by table (counts + sha256 of every column + foreign-key check). Equal: COMMIT, then flip the flag. Anything else: ROLLBACK (Postgres is exactly as it was) and the rollback is refused. | none when it commits           |
| The replay fails or does not verify, no replay URL, or live-side data that has no Postgres column (the CI-1 capture fields, `buyer_key`) | (b) REFUSED, by design. Do not use `--accept-data-loss`. Forward-fix: keep serving from Cloudflare, fix the defect there (revert the Worker with `docs/ROLLBACK.md` path A if the code is the problem, the data stays), and ask Ahmad before anything else.                                                                                                                                                                                  | none (nothing was rolled back) |
| Ahmad explicitly accepts discarding the live writes                                                                                      | `--accept-data-loss all` (or the affected slugs): the discarded row counts are printed first and logged in the register                                                                                                                                                                                                                                                                                                                      | the printed rows               |

Notes:

- The replay runs with owner privileges (no RLS), so it is fenced per store (security review): a diff row must carry the store being replayed, UPDATE / upsert / DELETE carry the same ownership predicate the migration read with, each write must affect exactly 1 row and an upserted row must read back as owned. A delete is bound to the row's REAL store (read inside the transaction, must be an allowed store, never NULL) and to the allowed store list. A row that claims another store, or that collides with a row of another store, aborts the whole transaction (rehearsal step 16b, unit tests `replay-ownership.test.ts`). After a committed replay the baseline is rebased, so repeating the rollback is a no-op.
- A store created or deleted on the live side after the flip is not replayable (refused). The freeze window keeps this empty.
- After a successful rollback the StoreDOs stay sealed and keep their data (nothing is deleted). To retry the cutover, run the rollback with `--reset-do` (wipes the DOs and the D1 baseline, needs the exact confirmation the script sends), then step 6 and 7 again from a fresh dump.
- Postgres stays intact for 7 days (Ruling CUTOVER-1). The replay needs a WRITABLE owner connection; it is the only step of the whole cutover that writes to Neon, and only on this path.
- If the flip-back itself does not restore service within 5 minutes, use `docs/ROLLBACK.md` path A (`wrangler rollback`) for the API and page Ahmad.
- Rehearsed (section 11, steps 12-21): no-write rollback, rollback refused without a replay URL, rollback refused and rolled back when a value has no Postgres column, rollback with replay (5 live changes: updated, added and deleted DO rows plus a D1 row) then `verify-store.mjs` PASS, `--reset-do` and a clean re-import.

## 10. After the cutover (7 days, then phase 7)

- Day 0-7: Neon untouched and read-only in practice (Neon billing unchanged); `/health` reports the DO backend for 100% of stores; Sentry clean; CF bill within projection. Record each day in the register.
- Plan 7.2 checks, daily: nightly DO export present in R2 for every store (`wrangler r2 object list ebda-backups --prefix backups/`), D1 time travel works, row-count assertions run, an alert exists for a missed backup. Re-run the restore drill (task 0.6) against the production export once.
- Day 1: delete `CUTOVER_IMPORT_SECRET` from `ebda-api` and the shell history (the stores are sealed anyway); remove `WRITES_FROZEN`.
- Day 7: Ahmad approves task 7.3 (delete Neon `lucky-truth-54548746` after a final `pg_dump` in cold storage). Removing is a production action: not before his explicit yes.

## 11. Rehearsal record and what is NOT verified

Rehearsal 2026-10-25 on `~/Desktop/projects/_backups/ebda/20261025T003439Z.sql.gz`, restored into database `ebda_cutover_rehearsal` on the shared PG17 (restore 2 s: 6 stores, 19 orders, 6 users as expected), run against local workerd (`wrangler dev`, StoreDO with the generated schema) and a local D1:

| Step                                                                         | Wall time     | Result                                                                              |
| ---------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| D1 schema apply (`wrangler d1 migrations apply --local`)                     | 1-3 s         | 2 migrations                                                                        |
| Dry run, all stores (read + transform + digest)                              | 1 s           | 2,673 rows, 0 errors                                                                |
| Platform to D1 (21 tables + `entity_index`)                                  | 2-3 s         | 37 rows (19 entity_index)                                                           |
| All stores to StoreDO (115 tables per store, 18 pages for the largest store) | 2-3 s         | 2,673 rows; largest store 939 rows in 0.47 s; slowest table `carts` 319 rows 0.15 s |
| Verify, all stores + D1                                                      | 2-3 s         | 690/690 DO tables + 22/22 D1 tables equal (712/712), 0 foreign-key violations       |
| Re-run same batch                                                            | 1-2 s         | every page "already applied" (no-op)                                                |
| Re-run new batch                                                             | 2 s           | upsert, verify still 712/712                                                        |
| Seal + flip + import refused (423) + rollback flip                           | 5 s each flip | works against a stand-in `storage_backend` column                                   |

Negative controls run (all behaved as designed): a single tampered category name made verify print `MISMATCH categories` and exit 1 while row counts were equal; re-migrating restored `PASS`; a wrong or missing bearer is 401; an import after seal is 423; a write on the source session is refused by Postgres (`cannot execute UPDATE in a read-only transaction`); a Neon host without `--allow-prod-read` is refused.

Findings from the rehearsal that the production run depends on:

1. **cf-schema bug (found by this run, fix belongs to PR #205 owner).** workerd caps LIKE/GLOB patterns at 50 bytes; the generated CHECK `product_option_values_swatch_hex_format` uses a 67-byte GLOB, so every non-null `swatch_hex` insert fails on a real DO ("LIKE or GLOB pattern too complex"). The rehearsal harness rewrites that one statement; the real StoreDO migration needs the generator fixed (e.g. `substr(c,1,1)='#' AND NOT (substr(c,2) GLOB '*[^0-9A-Fa-f]*')`) or the first product with a swatch will fail the import. Also the `products` hex check at line ~1585 is 49 bytes (just under the cap).
2. A DO accepts at most 100 KB per `sql.exec`; the 2,943-line init migration must be applied statement by statement (the harness shows the splitter, triggers end at `END;`).
3. Gold-rate products and variants are guarded by triggers (Ruling B5-13); the import raises `do_flags.gold_reprice` inside its own transaction.
4. `stores.storage_backend` is not in the generated D1 schema yet (task 2.4 owns it); `flip-backend.mjs` fails loudly until it exists. The rehearsal uses a stand-in column.
5. The dump is from before PR #223: its `stores`/`store_credentials` still hold the legacy WBS columns (ruled dropped, defaults/empty) and a `whatsapp_templates` table (ruled, empty). Production Neon may or may not have the #223 migration applied; both are handled.
6. One `onesignal_subscriptions` row belongs to the `qa-walk-store-1010` owner (placed there by the owner rule); `addresses` is empty. Re-check on the window dump (step 5.3 prints UNPLACED).

NOT verified (and what would settle it):

- **Production Neon was never connected to**; every number above is from the local dump. Settle: step 5.2-5.3 on the window dump.
- **Worker CPU limit per batch** is not enforced by local workerd. Largest real page here is 319 rows (about 150 ms wall including the Postgres read); real production data equals this dump, so the margin is large, but the CPU time on the deployed Worker is unmeasured. Settle: the first remote `migrate-store-to-do` run prints per-table wall time; Workers Logs show CPU time per request.
- **Phase 3 test suites against the migrated DOs**: the DO repo layer (`feat/cf-phase2-repo`) and money engines are other agents' branches and were not merged here. Settle: run their suites with the migrated DO state once merged, and the 8.4 smoke.
- **Remote D1 import path**: VERIFIED 2026-10-25 against a throwaway remote D1 (account `69188202...`, deleted afterwards): schema apply 3 s, `migrate-platform-to-d1` 6 s (37 rows, one `--file` call; a second run 4 s, idempotent), `verify-store.mjs --platform-only` 22/22 equal in 3 s. Remote file-size limits at production scale remain untested (the script caps files at 800 KB).
- **Shadow compare** here is a before/after GET sweep (public routes only). It does not exercise authenticated or write routes; the write path is covered only by the guest-cart smoke. Dual-read of pg vs DO in one request is not built.
- Vectorize embeddings and the analytics tables are not migrated by design (archived / rebuilt); their rebuild was not run.
