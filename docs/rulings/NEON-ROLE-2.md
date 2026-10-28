# NEON-ROLE-2

> Section: 2026-10-07 — Neon-safe strict-RLS role statement + layout save purges the storefront (branch `fix/neon-role-and-layout-cache`)

Ruling NEON-ROLE-2 — NOT FIXED HERE, recorded: a fresh Neon project also needs `pg_stat_statements` enabled for `20261003110000_enable_pg_stat_statements` (`CREATE EXTENSION` needs superuser on stock Postgres; on Neon it works for the project owner). The local proof pre-created the extension as a superuser to model Neon. Cost if wrong: a Neon plan or region that disallows the extension blocks migration at that file.

---

> Section: 2026-10-07 — INFRA-GAPS (branch `fix/infra-gaps`)

Ruling NEON-ROLE-2 (supersedes the "not fixed here" entry above) — FIXED: `20261003110000_enable_pg_stat_statements` ran a bare `CREATE EXTENSION`; pg_stat_statements is not a trusted extension, so a non-superuser owner got `permission denied to create extension` and `migrate deploy` stopped there. It is now a `DO` block that downgrades `insufficient_privilege`, `undefined_file` and `feature_not_supported` to a NOTICE. Reproduced and proven on a local PG16 container with a NOSUPERUSER/CREATEROLE/BYPASSRLS owner: old statement fails, new migration records as applied and the next migrations proceed. (The `ALTER ROLE ebda_app` failure that blocked a vanilla non-superuser run past `20261004000000` is NEON-ROLE-1, already fixed on main.) Applied prod DB: Prisma does not compare checksums on `migrate deploy`, but `migrate status`/`dev` would flag drift; the PR body carries the one-row UPDATE. Cost if wrong: on a database where the extension cannot be created the statistics view silently does not exist (nothing in the app reads it).
