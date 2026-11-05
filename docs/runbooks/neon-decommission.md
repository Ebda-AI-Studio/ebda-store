# Neon decommission (INFRA-CF-1 phase 7)

Runs only after the Cloudflare cutover (`docs/runbooks/cutover-cf.md`) has served production for **7 clean days**. Neon project `lucky-truth-54548746` stays intact and read-only until then (Ruling GO-1, CUTOVER-1). Deleting it is irreversible and happens ONLY on Ahmad's explicit yes. Every step below is driven by `scripts/cf/decommission-neon.mjs`, which enforces the order itself.

Owner: the cutover agent (phases 5 and 7). Approver for step 7: Ahmad.

## NEON-ZERO order (Ruling NZ-D23; supersedes the 7-day wait and the PR table below for the NEON-ZERO path)

Ahmad approved deleting the Neon project once the cutover is VERIFIED. Strict order, each step proven before the next:

1. Production cutover (copy scripts + markers) verified: `/api/v1/health` (super_admin) shows every live store `do`; the strict route sweep is green (`SWEEP_STRICT=1`).
2. Fresh final dump immediately before step 3 (`node scripts/cf/decommission-neon.mjs final-dump ...`, section 3 below). The restore drill passed on 2026-11-04; take a NEW dump now and record key, sha256 and counts in the register. `restore-drill` on the new object is optional only if the dump script's own verification and counts match.
3. Merge the N-17 lite PR (`feat/nz-remove-hyperdrive`, base `integ/neon-zero`; `deploy-change` label added by the controller after Ahmad's approval). It must NOT merge before steps 1 and 2.
4. Deploy runs (`cf-api-deploy.yml`, no Postgres step any more). Verify live, both halves: `/health` `commit` == tip of `main`, `postgres: "removed"`, `status: "ok"`; unknown slug 404; storedemo + one flipped store home / PDP / cart / admin login page; the sweep smoke against production read-only (GET routes, guest cart only, never a purchase). Sentry: no `POSTGRES_REMOVED` and no P1 `api.worker.postgres_removed` for one hour. Not verifiable by CI: that no scheduled job still reaches Postgres on its own tick (watch one full cron cycle).
5. Rollback window: the Neon project is still alive and unbound. A revert of the PR plus re-creating the Hyperdrive config (`wrangler hyperdrive create`, caching disabled) restores the old Worker. Observe 24 hours (section 5).
6. Delete the Neon project (Ahmad's explicit yes recorded in the register), then clean up:
   - disable `db-backup.yml` (`gh workflow disable db-backup.yml`; it dumps Neon nightly with `EBDA_MIGRATE_DATABASE_URL`) and remove the Ebda entry from `~/.claude/scripts/backup-all-neon.sh` + the `com.ebda.neon-backup` launchd job (section 2);
   - delete the GitHub secret `EBDA_MIGRATE_DATABASE_URL`, the repo variable `EBDA_HYPERDRIVE_ID` and the Hyperdrive config (`wrangler hyperdrive delete <id>`), and the Worker secrets `DATABASE_URL`, `DIRECT_URL`, `OWNER_DATABASE_URL` (the controller does this; the PR only STOPS USING them);
   - the later N-16 cleanup PR deletes the dead Postgres helpers, `packages/database` runtime and the Postgres CI lanes.

Secrets and variables the Worker deploy no longer reads after the PR: `EBDA_HYPERDRIVE_ID` (var), `EBDA_MIGRATE_DATABASE_URL` (secret, `cf-api-deploy.yml`), `DATABASE_URL` / `DIRECT_URL` step env of the deleted migrate step. Still read until Neon is deleted: `EBDA_MIGRATE_DATABASE_URL` by `db-backup.yml`.

## 0. Entry conditions (script: `preflight`)

```bash
node scripts/cf/decommission-neon.mjs preflight --flipped-at <ISO time of the flip> --api https://api.ebda.app --attest-sentry-clean
```

All must hold: at least 7 days since the flip; `/api/v1/health` `data.storage_backend` (super_admin, `OPS_HEALTH_TOKEN`) is 100% `do` and its commit is the tip of `main`; Sentry clean for the whole period (checked by hand, attested with the flag); the Worker config no longer has a `hyperdrive` binding (step 1 merged); DO nightly exports present in R2 for every store for the last 7 days (`npx wrangler r2 object list ebda-backups --prefix backups/` shows stores x 7); the CF bill is within the projection. A failing check prints the reason and exits 1: fix it, do not skip it.

## 1. Code cleanup of the Postgres paths (PRs, in this order; gate: `residue --strict`)

Baseline measured 2026-10-26 on the cutover branch: **378 files** still name Postgres, Prisma or Hyperdrive outside the exempt paths (`node scripts/cf/decommission-neon.mjs residue`). The goal is 0; the same command with `--strict` is the CI gate of the last PR and the precondition of steps 4 and 7.

| PR                  | Removes                                                                                                                                                                                                                                                                                                                                                                                                                            | Verify                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. selector         | the pg branch of `getStoreRepo` / `repo-factory`, `packages/repo/src/pg`, the `storage_backend` flag (the DO is the only backend), `/health` pg probes                                                                                                                                                                                                                                                                             | `npx vitest run apps/api/test/repo-factory.test.ts`, `npm run cf:test -w apps/api`                                                                    |
| 2. runtime          | `apps/api/src/lib/definer.ts`, `lib/savepoint.ts`, `lib/db-retry.ts`, `lib/cross-store.ts` Postgres paths, `middleware/tenant-context.ts` GUCs, the Hyperdrive binding in `apps/api/wrangler.jsonc`, `scripts/ebda-cf-api-config.mjs` Hyperdrive substitution, `EBDA_HYPERDRIVE_ID` use in `cf-api-deploy.yml`                                                                                                                     | `npm run cf:build -w apps/api`; `scripts/ci/worker-startup-budget.mjs` stays inside its budget                                                        |
| 3. database package | `packages/database/src/{index,tenant-guard,tenant-gucs,client}.ts`, Prisma deps (`@prisma/client`, `@prisma/adapter-pg`, `pg`), the tenant-guard snapshot test; `schema.prisma` and `migrations/` MOVE to `docs/legacy/` (the parity source for `cf-schema` until the generator reads the archived copy)                                                                                                                           | `npm ci`, `npm audit` 0/0/0/0, `packages/cf-schema` `generated-current` test points at `docs/legacy/`                                                 |
| 4. tests and CI     | `tests/integration` Postgres suites replaced by their DO equivalents, the `postgres` service container in `ci.yml`, the throwaway-Postgres smoke in `scripts/ci/workerd-smoke.sh`, `prisma migrate deploy` + `EBDA_MIGRATE_DATABASE_URL` in `cf-api-deploy.yml`, `db:generate` in `.husky/pre-push`, `docker-compose` Postgres, `scripts/backup-db.sh` pre-push dump, `scripts/legacy-pg/` and the one-off `scripts/backfill-*.ts` | `bash scripts/cf/rehearse-cutover.sh` is NOT removed (it is the archive of how data moved) but moves under `docs/legacy/` when this runbook is closed |
| 5. docs             | `docs/DEPLOYMENT.md`, `docs/INCIDENT.md` (Neon status page, P0 checklist), `docs/ROLLBACK.md` (Neon PITR), `docs/DB-BACKUP-RESTORE.md` (now DO export + D1 time travel), `docs/ENVIRONMENT.md` (`DATABASE_URL`, `DIRECT_URL`, cutover rows), `CLAUDE.md` (stack, RLS, tenant guard sections), the global memory index                                                                                                              | doc parity: same PR set                                                                                                                               |

Each PR: touched tests, `blast-radius` sweep over the removed identifiers (`DATABASE_URL`, `DIRECT_URL`, `HYPERDRIVE`, `EBDA_HYPERDRIVE_ID`, `EBDA_MIGRATE_DATABASE_URL`, `ebda_app`, `withOwnerTx`, `acrossStores`), merge through the merge gate, then confirm `/health` commit = main tip (a merge is not a deploy). After PR 4 `residue --strict` exits 0.

## 2. Backups stop depending on Neon (plan 7.2)

Confirm before anything is deleted: the nightly DO export alarm wrote an object per store per day for 7 days, D1 time travel answers (`wrangler d1 time-travel info ebda-platform`), the missed-backup alert fires in a test, and the restore drill (plan task 0.6) passes on a production export. Then remove ONLY the Ebda project entry from `~/.claude/scripts/backup-all-neon.sh` (list the script's project set first and show it before editing; the other projects stay) and the `com.ebda.neon-backup` launchd job.

## 3. Final encrypted dump to R2 and the restore drill (scripts: `final-dump`, `restore-drill`)

One backup scheme: the ops agent's nightly `db-backup.yml` (branch `fix/deploy-pipeline-gates`, `docs/DB-BACKUP-RESTORE.md` Layer 2): `pg_dump --format=custom --no-owner --no-privileges`, verified by `scripts/ops/verify-db-dump.sh`, encrypted with **age** to the public key in repo variable `EBDA_BACKUP_AGE_PUBLIC_KEY`, stored in R2 bucket **`ebda-db-backups`** (object lock 7 days on `db/`, 35-day expiry). The private key exists only in Ahmad's macOS Keychain (`ebda-db-backup-age-key`). The final dump is the same format under `final/`, so the 35-day expiry of `db/` never touches it.

```bash
node scripts/cf/decommission-neon.mjs final-dump --r2-account <Cloudflare account id of ebda-db-backups> --lifecycle-checked
node scripts/cf/decommission-neon.mjs restore-drill --manifest <manifest> --scratch-pg-url postgres://postgres@localhost:54417/ebda_decom_drill_scratch
dropdb -h localhost -p 54417 -U postgres ebda_decom_drill_scratch
```

`final-dump` (Neon only READ, session forced read-only): refuses a pooler URL, `pg_dump` < 17 and a missing `scripts/ops/verify-db-dump.sh`; prints the bucket's lifecycle rules and makes you confirm (`--lifecycle-checked`) that none expires `final/` (ask ops to add an exemption or a separate prefix rule BEFORE the dump if one does); dumps, verifies with the ops script, compares live `SELECT count(*)` of stores, orders, users, products and customers with the rows inside the dump (a mismatch means a write happened during the dump), encrypts with age, uploads to `ebda-db-backups/final/`, reads it back and compares sha256, and writes a 0600 manifest with `drillOk: false`.

`restore-drill` is **mandatory**: it fetches the object from R2, checks the sha256, decrypts with the Keychain key on this Mac (key file 0600 in a private mkdtemp, removed in `finally`), verifies the dump again, restores it into a scratch database (the name must contain `scratch`, `drill` or `rehearsal` and never be Neon) and compares the five counts with the manifest. Only a pass sets `drillOk`; `remove-bindings` and `delete-neon` refuse without it. Drop the scratch database afterwards and delete the local plaintext dump.

Retention: the R2 object under `final/` is the cold copy and is kept until Ahmad says otherwise; record key, sha256 and counts in the register. The age private key is the single point of failure: confirm with Ahmad that the Keychain item is backed up before step 7.

## 4. Remove the Postgres bindings (script: `remove-bindings`)

```bash
node scripts/cf/decommission-neon.mjs remove-bindings --manifest <manifest>            # prints the plan
EBDA_HYPERDRIVE_ID=<id from wrangler hyperdrive list> node scripts/cf/decommission-neon.mjs remove-bindings --manifest <manifest> --yes
```

Refuses without a verified manifest and without `residue` at 0 (removing a binding the Worker still uses would take the API down). It deletes the `DATABASE_URL`, `DIRECT_URL`, `OWNER_DATABASE_URL` secrets on `ebda-api`, the GitHub secret `EBDA_MIGRATE_DATABASE_URL`, the repo variable `EBDA_HYPERDRIVE_ID`, and the Hyperdrive config. Afterwards: `/health` green, a guest cart (never a purchase), Sentry quiet for one hour. Rollback of this step: recreate the Hyperdrive config and secrets from the still-alive Neon project (only possible until step 7).

## 5. Observation window

24 hours with Neon alive but unbound: nothing may depend on it. Check Neon's own connection metrics (`neonctl` / console: active connections must be zero apart from the monitoring that is about to go) and Sentry for `ECONNREFUSED` / `getaddrinfo` against `neon.tech`. A single hit = something still uses Postgres: restore the binding, find it, add it to `residue`'s pattern, repeat.

## 6. Ahmad's yes

Send Ahmad: the preflight output, the manifest (key, size, sha256, row counts), the restore-drill result, confirmation that the Keychain age key is backed up, the residue result (0), the 24 h observation result, and the exact sentence "delete Neon project lucky-truth-54548746". Nothing happens without his written yes in the session or the register. A yes given earlier for the cutover (GO-1) is NOT a yes for the deletion.

## 7. Delete the project (script: `delete-neon`, the only irreversible step)

```bash
node scripts/cf/decommission-neon.mjs delete-neon --manifest <manifest> --ahmad-yes "<register line or message where he said yes>"
```

Needs a terminal (no unattended delete), the manifest, `residue` at 0 and a healthy `/health`; asks you to type the project id back. Then it verifies `neonctl projects list` no longer shows it.

## 8. After

`/health` green, a guest cart, Arabic storefront of one store, admin login. Update the same-day docs: DEPLOYMENT, INCIDENT, ROLLBACK, DB-BACKUP-RESTORE, ENVIRONMENT, `CLAUDE.md`, the Neon cost line in the billing reference, and the global memory (project is gone, cold copy location). Move `scripts/cf/rehearse-cutover.sh`, `docs/runbooks/cutover-cf.md` and this runbook's scripts under `docs/legacy/` or mark them historical. Record the closing Ruling (`Ruling DECOM-1 - Neon deleted on <date> on Ahmad's yes, cold copy <key> sha256 <hash>. Cost if wrong: the only Postgres copy is the age-encrypted R2 object; losing the Keychain age key loses the history.`).

## Guardrails (what the script refuses)

| Command           | Refuses when                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`       | under 7 days, `/health` not 100% `do` or not on the tip of `main`, Sentry not attested, a Hyperdrive binding still in `wrangler.jsonc`                                                        |
| `final-dump`      | no R2 account, pooler URL, ops verify script missing, pg_dump < 17, malformed age key, lifecycle not acknowledged, failed ops verification, live-vs-dump count mismatch, R2 read-back differs |
| `restore-drill`   | no scratch URL, a database name without scratch/drill/rehearsal or a Neon host, sha256 differs from the manifest, restored counts differ                                                      |
| `remove-bindings` | unverified or wrong-project manifest, `residue` not 0                                                                                                                                         |
| `delete-neon`     | no manifest, no `--ahmad-yes`, `residue` not 0, `/health` down, not a terminal, the typed id differs                                                                                          |

Not verified (this runbook was written before the cutover ran): the R2 account id of `ebda-db-backups` and whether its lifecycle exempts `final/` (ops to confirm), the dependency on `scripts/ops/verify-db-dump.sh` from `fix/deploy-pipeline-gates`, the exact list of Worker secrets in production (`wrangler secret list --name ebda-api` decides; the script ignores a secret that is already gone), and the code-cleanup PR sizes. The destructive commands were exercised only as refusals (see `packages/cf-migrate/test/decommission-guards.test.ts`); no Neon, R2 or Cloudflare resource was touched.
