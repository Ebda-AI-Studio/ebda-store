/**
 * NEON-ZERO N-17 (Ruling NZ-D23): a deployed Worker with no HYPERDRIVE binding has no Postgres. Code that only exists to reach a
 * Postgres copy (a retention sweep over Postgres users, a scrub of a stale Postgres row, the database clock) asks here and SKIPS
 * with a reason: a Prisma call on such a Worker raises a P1 POSTGRES_REMOVED (2026-11-06 incident) and can never succeed.
 * Node (Railway, vitest, scripts) has no binding object, so it is never "removed".
 */
import { cfBindings } from '../cf/bindings';
import { isWorkers } from './runtime';

export const postgresRemovedOnThisWorker = (): boolean =>
  isWorkers && !(cfBindings() as { HYPERDRIVE?: unknown } | undefined)?.HYPERDRIVE;
