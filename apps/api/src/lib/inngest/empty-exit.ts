/**
 * Empty-run exit for polling crons (Ruling INNGEST-BUDGET-1).
 *
 * Inngest bills an execution per function run PLUS one per `step.run` (Executions =
 * runs x (steps + 1); https://www.inngest.com/pricing, calculator note). A sweep that opens with
 * `step.run('find-...')` therefore costs two executions on a tick that finds nothing, and a sweep
 * with two find steps costs three. This reads the same query un-stepped first: nothing found,
 * return `[]` and the run is ONE execution. Something found, `step.run` memoises the read exactly
 * as before, so every later step sees a stable snapshot and the retry semantics are unchanged.
 *
 * Caller contract: `fn` is a READ (idempotent, cheap) and the caller already treats an empty
 * result as "nothing to do". On a later invocation of the same run (Inngest re-enters the handler
 * once per step) the un-stepped read can come back empty because the work just got done; that
 * ends the run early, which is correct for a sweep (nothing left to fix) and skips only a
 * very-stale alert about rows that have since cleared.
 */
export interface StepLike {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function stepRunUnlessEmpty<T>(
  step: StepLike,
  id: string,
  fn: () => Promise<T[]> | T[]
): Promise<T[]> {
  const probe = await fn();
  if (probe.length === 0) return probe;
  return step.run(id, async () => fn());
}
