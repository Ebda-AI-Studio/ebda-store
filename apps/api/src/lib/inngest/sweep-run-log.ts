import logger from '../logger';

/**
 * One structured summary line per scheduled sweep run, including a run that found nothing (the empty-exit path logs nothing
 * else, so a run of a sweep was invisible in R2 Logpush). Counts only: a field that is not a finite number is dropped, so
 * an id, a name or any personal data can never ride on this line. Returns its input so a handler can `return logSweepRun(...)`.
 */
export function logSweepRun<T extends Record<string, unknown>>(sweep: string, counts: T): T {
  const numbers: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts))
    if (typeof v === 'number' && Number.isFinite(v)) numbers[k] = v;
  logger.info({ event: 'sweep.run', sweep, ...numbers }, `[sweep-run] ${sweep}`);
  return counts;
}
