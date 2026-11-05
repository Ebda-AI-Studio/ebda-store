# NZ-17-EX-1

> Section: NEON-ZERO N-17 Postgres removal, slice 1 (2026-11-05)

**Ruling NZ-17-EX-1 - `packages/database/prisma/migrations/` is exempt from `decommission-neon.mjs residue`.** It is the applied Postgres migration history (RLS, `pg_*`, GUC SQL), kept as an archive for the restore drill and for rebuilding the schema's history; nothing runs it in production and `check-migration-order.mjs` still guards its ordering. Only this directory is exempted: `schema.prisma`, the client factory and seeds still count as residue and are removed or exempted by a later ruling with their own evidence. Cost if wrong: a Postgres-only statement added under migrations goes unreported by the residue gate (the order guard still sees it).
