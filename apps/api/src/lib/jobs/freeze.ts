/**
 * The write freeze for background work (Ruling CF-JOBS-2, replaces "pause Inngest" in docs/runbooks/cutover-cf.md).
 *
 * `WRITES_FROZEN=1` already makes the HTTP layer answer 503 (middleware/write-freeze.ts). Every OTHER writer honours the
 * same variable here: crons, queue consumers, Workflow instances/steps and Durable Object alarms. The rule is always
 * "do not run now, run later, never drop":
 *   - a queue message is re-sent with a delay (not retried: a retry spends an attempt and ends in the DLQ);
 *   - a Workflow instance sleeps before its first step and before EVERY later step;
 *   - a StoreSchedule alarm keeps its due time and is re-armed 5 minutes out (no attempt is spent);
 *   - a cron tick of a SWEEP (the same job fires again within `CATCH_UP_MS`) is skipped, because the next tick after
 *     the window does the work; a cron tick of anything rarer is STARTED and parked, because no later tick would catch up.
 * The variable is OFF unless it is exactly "1" (a typo can never freeze production), and it is read at run time from
 * `process.env` or the Worker bindings, so a Worker var change plus deploy is all the runbook needs.
 */
import { cfBindings } from '../../cf/bindings';
import { nextRunAfter } from './next-run';

/** How long a parked message / instance / alarm waits before looking at the flag again. */
export const FREEZE_PARK_SECONDS = 300;
/** A parked message gives up (loudly, failure path) after this many waits: 24 h of freeze. */
export const FREEZE_MAX_WAITS = 288;
/** A cron whose next occurrence is within this window is a sweep: the tick after the window catches up. */
export const CATCH_UP_MS = 6 * 3_600_000;

/** `env` = the Worker / Durable Object bindings when the caller has them (a DO has no `cfBindings()` until it sets them). */
export function writesFrozen(env?: object): boolean {
  return (
    process.env.WRITES_FROZEN === '1' ||
    (env as { WRITES_FROZEN?: unknown } | undefined)?.WRITES_FROZEN === '1' ||
    cfBindings()?.WRITES_FROZEN === '1'
  );
}

/** Is this cron a sweep (true) or a rare job that must be parked (false)? */
export function isSweepCron(expr: string, at: number = Date.now()): boolean {
  const first = nextRunAfter(expr, at);
  const second = nextRunAfter(expr, first);
  return second - first <= CATCH_UP_MS;
}
