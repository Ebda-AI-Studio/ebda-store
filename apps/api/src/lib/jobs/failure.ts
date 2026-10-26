import * as Sentry from '@sentry/cloudflare';
import logger from '../logger';
import { sendAlert } from '../../services/alerts.service';
import { JOBS_MAP } from './jobs-map';
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

/**
 * A job's FINAL failure (retries spent, NonRetriable, gate never freed, DLQ, alarm start given up):
 * alert straight away, independent of any `inngest/*` event. The same P1 platform alert path as
 * alerts-failure-watch (P0 for the payment webhook, which can leave a paid order unpaid), plus Sentry.
 * Only the job id, group, run id, trigger event NAME and the error are included; never event data
 * (it can hold customer fields) and the message is truncated. Never throws: an alert miss must not
 * fail the run's own failure step.
 */
export async function reportJobFailure(
  def: JobDef,
  event: JobEvent,
  runId: string,
  error: Error
): Promise<void> {
  const group = JOBS_MAP[def.id]?.group ?? 'unmapped';
  const money = def.id === 'payment-webhook-process';
  const message = (error.message || 'unknown error').slice(0, 300);
  try {
    await sendAlert({
      level: money ? 'p0' : 'p1',
      scope: 'platform',
      source: `job.${def.id}`,
      title: money
        ? `PAYMENT webhook processing failed past final retry: ${def.id}`
        : `job failed: ${def.id}`,
      body: message,
      context: {
        job: def.id,
        group,
        instanceId: runId,
        errorName: error.name,
        triggeringEvent: event.name,
      },
    });
  } catch (err) {
    logger.error({ err, job: def.id }, '[jobs] failure alert not sent');
  }
  try {
    Sentry.captureException(error, {
      tags: { job: def.id, group },
      extra: { instanceId: runId, triggeringEvent: event.name },
    });
  } catch (err) {
    logger.warn({ err, job: def.id }, '[jobs] failure not sent to sentry');
  }
}
