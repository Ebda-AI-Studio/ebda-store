# Backup dumps are asserted, not just counted

**Date:** 2026-09-17
**Branch:** `fix/db-backup-assert-dump-not-empty`
**Scope:** `.github/workflows/db-backup.yml`, `scripts/backup-db.sh`, `scripts/verify-dump.sh` (new), `.husky/pre-push`, docs.

**Goal:** no path in this repo may write, upload, or keep a database dump it has not proved can restore.

---

## 1. The defect

### 1.1 What was actually there (premises checked first)

The brief that opened this work stated that `db-backup.yml` never sets `pipefail` and only PRINTS the
artifact size. **Both are false on `origin/main`** and were verified before anything was changed:

- the step already opens with `set -euo pipefail`, so a `pg_dump` failure inside
  `docker run … | gzip | openssl …` already failed the step; the exit status was never `openssl`'s alone.
- the size was already asserted: `[ "${SZ:-0}" -gt 200 ] || { echo "::error::…"; exit 1; }`.

Recording this because the fix that follows is narrower and more specific than "add pipefail", and
because a plan that repeats an unchecked premise teaches the next reader the wrong lesson.

### 1.2 The real hole

The only quality bar on the R2 backup was **a byte count on the ENCRYPTED artifact**. That fails to
distinguish the failure that actually destroys a DR position:

| dump state              | plain size  | encrypted size | old gate | restores?             |
| ----------------------- | ----------- | -------------- | -------- | --------------------- |
| healthy                 | ~tens MB    | ~1.4 MB        | pass ✅  | yes                   |
| zero bytes              | 0           | ~48 B          | fail ✅  | no                    |
| **schema-only / wiped** | **~3.5 KB** | **~3.5 KB**    | **pass** | **an empty database** |

The third row is not hypothetical. On 2026-08-02 the Ebda AI Studio CRM production database was wiped and
its nightly backup archived **30 consecutive schema-only dumps**, each far above any byte floor, each
reported as a success, for five weeks. The DR that was supposed to make the wipe survivable had been
backing up an empty database the whole time.

Two structural aggravations here:

1. **The artifact is encrypted immediately.** Once `openssl` has run, nothing downstream — not the job,
   not a restore six weeks later — can tell a full dump from an empty one without the key and a manual
   look. Whatever is going to be asserted must be asserted on the plaintext, in that one step.
2. **The job had no `actions/checkout`.** With no repo on the runner, an inline byte count was the only
   check it _could_ perform. That is why the gate was the shape it was.

---

## 2. The check

`scripts/verify-dump.sh` — one sourceable/executable function, `verify_dump <dump.sql.gz>`. It prints
**counts only**, never dump contents (the dump is customer PII).

| #   | assertion                            | threshold                     | why this threshold                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `gzip -t` integrity                  | pass/fail                     | Catches a stream killed mid-write. A dump interrupted by a dropped connection still leaves a file behind.                                                                                                                                                                                                                                                   |
| b   | decompressed size                    | **≥ 1024 bytes**              | Catches zero-byte and truncated-first-block dumps. Deliberately NOT tuned near the real dump size (~tens of MB plain): the row assertion is the gate with teeth, and a tight floor only invents false failures as the database grows or shrinks.                                                                                                            |
| c   | `-- PostgreSQL database dump` header | must appear in first 20 lines | Catches "something else was captured" — a proxy's HTML 502, an error page, a partial write. Matches the manual check this runbook already told operators to do by eye.                                                                                                                                                                                      |
| d   | `CREATE TABLE` count                 | **≥ 1**                       | Closes the both-sides-absent hole in (e): with zero tables and zero rows, `rows < tables` is `0 < 0` = **false**, so a completely empty dump would PASS the content check. The reference implementation has this hole and survives it only because its byte floor happens to fire first. Closed explicitly rather than left to another check's luck.        |
| e   | data rows vs tables                  | **rows ≥ tables**             | The CRM assertion, ported verbatim in spirit from `~/.claude/scripts/backup-all-neon.sh`. Any real database has more data rows than it has tables. Compared against the TABLE COUNT and never against zero: the CRM dump that hid a total data loss was not empty — it held exactly one bookkeeping row, so `rows == 0` would have sailed straight past it. |

Rows are counted in one `awk` pass: lines between `COPY … FROM stdin;` and a lone `\.`, **plus**
`INSERT INTO` statements so an `--inserts`-format dump is not falsely condemned.

Implementation notes that are load-bearing:

- The gzip is decompressed **once to a temp file** and every check runs over that file. Piping
  `gzip -dc` into `head`/`grep -q` lets those exit early, SIGPIPEs the decompressor, and under
  `pipefail` fails the check for a reason unrelated to the dump.
- Exit codes: `0` plausible, `1` not a valid backup (reason on stderr), `2` usage.

### 2.1 Where it is wired

| path                              | before                                         | after                                                                                |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `.github/workflows/db-backup.yml` | dump → gzip → encrypt → size check → upload    | checkout → dump → gzip **to temp file** → **verify** → encrypt → size check → upload |
| `scripts/backup-db.sh`            | dump → gzip straight onto the destination path | pre-flights → dump → gzip **to temp file** → **verify** → rename into place          |

Encryption, rclone upload, retention/prune and secrets handling are untouched. The encrypted-artifact
size check is kept (it now catches a truncated write or failed encryption between the verify and the
upload) with its message corrected to say what it actually measures.

---

## 3. The producer of the empty local dumps — **identified**

Six archives in `~/Desktop/projects/_backups/ebda-store/` are valid gzip files containing
zero bytes, named `<UTC timestamp>-<8-char commit>.sql.gz`.

**Verdict: `scripts/backup-db.sh`, in this repo, invoked from `.husky/pre-push` on `main`.**

Evidence:

1. **Only this script produces that filename.** `backup-db.sh:34` is
   `OUT="${BACKUP_DIR}/${TS}-${SHA}.sql.gz"` with `SHA="$(git rev-parse --short HEAD)"`. Nothing else in
   the repo, in `~/.claude/scripts/`, or in `~/Library/LaunchAgents/` writes a commit-suffixed dump. The
   nightly `backup-all-neon.sh` writes `<TS>.sql.gz` with no suffix and already rejects both failure
   modes.
2. **The suffix length matches.** `git rev-parse --short HEAD` returns **8** characters in this repo
   (git auto-sizes the abbreviation; `core.abbrev` is unset), matching `6af9aa42` / `ab115798` — not the
   7 the brief assumed.
3. **The SHA is this checkout's HEAD, not the day's commit.** `6af9aa42` is the Sep 13 commit the repo
   root was still parked on when the Sep 16 file was written, which is exactly what
   `git rev-parse --short HEAD` yields — and is why it looked anomalous against the Sep 16 timestamp.
4. **The root cause reproduces on demand.** `pg_dump` on the default PATH is Homebrew's **14.24**; Neon
   serves **17.11**. Run against the repo's own `DATABASE_URL`:

   ```
   pg_dump: error: server version: 17.11; pg_dump version: 14.24
   pg_dump: error: aborting because of server version mismatch
   exit=1
   ```

   Replaying the script's exact pipeline produced **a 20-byte gzip decompressing to 0 bytes** — byte-for-byte
   the artifact found. `backup-all-neon.sh` avoids this by putting `/opt/homebrew/opt/postgresql@17/bin`
   first on PATH; `backup-db.sh` never did.

5. **Nothing surfaced it.** `2>/dev/null` discarded the error; the `> "$OUT"` redirect had already created
   the destination so `gzip` produced a valid empty archive; `.husky/pre-push` calls the script
   non-blocking and printed a reassurance that a "cloud snapshot still runs" — itself false since
   `neon-snapshot.yml`'s push trigger was retired 2026-06-08.
6. **A second, independent cause is present in the same input.** The repo `.env` carries Neon's **pooled**
   URL. pg_dump 17 against it did not fail cleanly — it **hung** until a 30s alarm killed it. That is a
   worse variant: no error line at all.

The Aug 19 cluster (three files inside ~90 minutes, all `ab115798`) fits the same shape: repeated pushes
to `main` from a checkout parked on that commit, each firing the hook, each dumping with pg_dump 14.

### What could NOT be re-verified

The four named artifacts are **no longer on disk** — checked 2026-09-17, all four absent from
`~/Desktop/projects/_backups/ebda-store/` (Ahmad owns that tree and had already cleared
them). So the verdict above rests on the reproduction, the naming scheme and the invocation path, not
on re-inspecting the files themselves. Anyone re-checking this later will not find them.

For the record, the counts that _were_ measured: the fleet-wide tree holds **188** `.sql.gz` files
across 17 project directories, of which this project holds **26** — so the "193 archives" in the
original report is the FLEET-wide figure, not this project's directory, and retention (cap 30 per
project) is working normally.

**Positive control against production data.** `verify-dump.sh` was run against the current real Ebda Store
dump and accepts it:

```
verify-dump: OK — 18450302 bytes plain, 108 tables, 65498 data rows  (exit 0)
```

That matters as much as the failure cases: it shows the thresholds do not false-fail on a live
108-table database, which is the way a gate like this usually goes wrong in the other direction.

### Fixes applied to the producer

- PG17 keg first on `PATH`, plus an explicit **pre-flight** that refuses to run when `pg_dump` major is
  below the server major, naming `brew install postgresql@17`.
- An explicit **pre-flight** refusing a `-pooler.` URL, naming the `neonctl` command that yields the
  direct one.
- pg_dump stderr captured and its **last line printed** on failure, instead of `2>/dev/null`.
- Dump written to a temp file and **verified** before it is allowed to take a backup's name.
- A dump that fails verification is parked as `<name>.sql.gz.SUSPECT` — kept as evidence of when the
  data disappeared, but deliberately **outside the `*.sql.gz` glob** that `docs/ROLLBACK.md` restores
  from, so it can never be selected as "the most recent backup".
- The false pre-push reassurance replaced with what actually covers the push.

---

## 4. Tests

`scripts/verify-dump.test.sh` — pure bash + gzip + awk. No database, no network, no secrets, no
`node_modules`, so it runs in a bare worktree and on any runner. Fixtures are realistic pg_dump plain
output built on the fly.

| case                                            | expected |
| ----------------------------------------------- | -------- |
| valid dump, 3 tables / 8 data rows              | exit 0   |
| empty (zero-byte) dump — **the artifact found** | exit 1   |
| truncated gzip                                  | exit 1   |
| schema-only dump, 3 tables / 0 rows             | exit 1   |
| 4 KB non-dump payload (clears the byte floor)   | exit 1   |
| 0 tables AND 0 rows (the `0 < 0` hole)          | exit 1   |
| missing file                                    | exit 1   |

Plus two **positive controls**, because a suite that silently tests nothing reports success forever: the
valid fixture really carries 8 data rows, and the schema-only fixture is 1216 bytes — above the floor, so
it is provably rejected on CONTENT rather than on size.

`tests/unit/db-backup-verify-dump.test.ts` wraps the suite so the **required** "Unit Tests" job runs it,
and asserts both writing paths still CALL the verifier. A gate with zero call sites passes its own tests
forever while protecting nothing.

### Mutation results

| mutation                              | result                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| delete the `rows >= tables` assertion | schema-only case goes **red** (`OK — 1216 bytes, 3 tables, 0 data rows`) |
| delete the `tables >= 1` assertion    | zero-tables case goes **red** (`OK — 2554 bytes, 0 tables, 0 data rows`) |

Both restored byte-identical (`cmp` clean); suite green before and after.

---

## 5. Rulings

**Ruling DB-1 — the byte floor stays at 1024 decompressed rather than being tuned to the real dump size.**
A floor near the true size would catch a partial dump slightly earlier, but would need re-tuning every
time the database changes size and would fail closed on a legitimately small future database. The row
assertion covers the case a tighter floor would buy. _Cost if wrong:_ a dump truncated somewhere between
1 KB and its true size passes (b) — and is then caught by (a) `gzip -t` or (e) rows≥tables unless the
truncation lands exactly on a block boundary after the last COPY block, a window this accepts.

**Ruling DB-2 — the local pre-push backup stays NON-BLOCKING.**
It is a convenience dump before a push, not the DR layer (that is the nightly R2 job + PITR). Making it
blocking would gate every push to `main` on a database round-trip. The fix is that it can no longer fail
_silently_: it prints the real reason and never leaves a plausible-looking artifact. _Cost if wrong:_ a
push proceeds without a fresh local dump; the R2 layer and PITR still cover the window.

**Ruling DB-3 — the six existing empty archives are left in place.**
They are outside this repo (`~/Desktop/projects/_backups/`, explicitly Ahmad's tree) and are evidence.
_Cost if wrong:_ someone restores from one — mitigated because `verify-dump.sh` now exists to check any
candidate before use, and the runbook tells them to run it.

**Ruling DB-4 — `PROJECT_NAME` is still `basename "$(git rev-parse --show-toplevel)"`, unchanged.**
Run from a git worktree this resolves to e.g. `ebda-store__fix-foo` and would write into a
differently-named backup directory. Not fixed here: the only caller runs on `main` in the root checkout,
and changing the destination path is a bigger blast radius than this PR's subject. _Cost if wrong:_ a
manual run from a worktree creates a stray `_backups/<worktree-name>/` directory — noisy, not lossy.

---

## 6. Documentation parity

- `docs/DB-BACKUP-RESTORE.md` — Layer 2 now documents verify-before-encrypt and why; the "verify a dump
  before trusting it" instruction now names `scripts/verify-dump.sh` instead of eyeballing `zcat | head`
  (which cannot distinguish a schema-only dump — the whole point); Layer 1's pg_dump-version requirement
  now states the measured failure rather than "silently produces empty dumps"; `.SUSPECT` files are
  explained.
- `.husky/pre-push` — the false "cloud snapshot still runs" reassurance corrected.
- `docs/security/security-overview.md` + `docs/business/vendor-liability-exposure.md` — both described
  the local dump layer as **9** rotations / "9 rolling copies". The script keeps **30**
  (`KEEP="${NEON_BACKUP_KEEP:-30}"` in `backup-all-neon.sh`, raised 2026-07-01), which
  `docs/DB-BACKUP-RESTORE.md`, `docs/ROLLBACK.md` and `docs/DEPLOYMENT.md` already said. Corrected in
  all three remaining places rather than the one that was reported — a wrong number in a security doc
  describing recovery capability is the same defect wherever it appears.
