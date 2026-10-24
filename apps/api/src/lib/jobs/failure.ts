import logger from '../logger';
import type { JobDef, JobEvent } from './types';

/** The `inngest/function.failed` event Inngest emits; alerts-failure-watch subscribes to it. */
export function failedEvent(
  def: JobDef,
  event: JobEvent,
  runId: string,
  error: Error
): { name: string; data: Record<string, unknown> } {
  return {
    name: 'inngest/function.failed',
    data: {
      function_id: def.id,
      run_id: runId,
      event,
      error: { name: error.name, message: error.message, stack: error.stack?.slice(0, 1500) },
    },
  };
}

/** Run the function's `onFailure` (best effort: its own error never masks the original). */
export async function runOnFailure(def: JobDef, event: JobEvent, runId: string, error: Error) {
  const fn = def.options.onFailure;
  if (!fn) return;
  try {
    await fn({ event: failedEvent(def, event, runId, error), error });
  } catch (err) {
    logger.error({ err, job: def.id }, '[jobs] onFailure threw');
  }
}
