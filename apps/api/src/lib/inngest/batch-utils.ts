/**
 * Shared helper for the crash-resumable bulk-AI sweep pattern (PR2).
 *
 * Every bulk-ai-* Inngest function loads its full item list inside a single
 * `step.run('load-items', ...)` (stable set + order across retries — Inngest
 * memoizes the result), then splits it into fixed-size chunks and wraps EACH
 * chunk in its own `step.run(\`batch-${i}\`, ...)`. Because completed steps
 * are memoized, a function-level retry after a crash skips every batch that
 * already finished and resumes at the first unfinished one — no custom
 * cursor bookkeeping needed.
 */
export const BULK_AI_BATCH_SIZE = 15;

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
