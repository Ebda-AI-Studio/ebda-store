import * as Sentry from '@sentry/cloudflare';
import logger from '../logger';
import { sendAlert } from '../../services/alerts.service';
import { JOBS_MAP } from './jobs-map';
import { probeSentry, type SentryProbeResult } from './sentry-probe';
import type { JobDef, JobEvent } from './types';
import { timedFetch } from '../fetch-with-timeout';

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

export interface JobFailureReport {
  /** `sent` / `throttled` / `skipped` (Telegram not configured) / `failed` / `error` (the call threw). */
  alert: string;
  /** Sentry event id, or null when no client is active in this context. */
  sentryEventId: string | null;
  /** Did Sentry's flush finish within its budget? A step that ends before the flush loses the event. */
  sentryFlushed: boolean;
  /** Only when the flush did not finish: a direct POST to the ingest endpoint, to show why. */
  sentryProbe?: SentryProbeResult | { error: string };
}

/**
 * A job's FINAL failure (retries spent, NonRetriable, gate never freed, DLQ, alarm start given up):
 * alert straight away, independent of any `inngest/*` event. The same P1 platform alert path as
 * alerts-failure-watch (P0 for the payment webhook, which can leave a paid order unpaid), plus Sentry.
 * Only the job id, group, run id, trigger event NAME and the error are included; never event data
 * (it can hold customer fields) and the message is truncated.
 *
 * Both sends are AWAITED and their results returned (the Workflow stores them as the step output,
 * so "did it reach Telegram / Sentry" is readable from the instance). A Workflow step has no
 * `waitUntil`: an un-awaited send or an un-flushed Sentry event is lost when the step returns.
 * Never throws: an alert miss must not fail the run's own failure step.
 */
export async function reportJobFailure(
  def: JobDef,
  event: JobEvent,
  runId: string,
  error: Error
): Promise<JobFailureReport> {
  const group = JOBS_MAP[def.id]?.group ?? 'unmapped';
  const money = def.id === 'payment-webhook-process';
  const message = (error.message || 'unknown error').slice(0, 300);
  const report: JobFailureReport = { alert: 'error', sentryEventId: null, sentryFlushed: false };
  try {
    report.alert = await sendAlert({
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
    report.sentryEventId =
      Sentry.captureException(error, {
        tags: { job: def.id, group },
        extra: { instanceId: runId, triggeringEvent: event.name },
      }) || null;
    report.sentryFlushed = await Sentry.flush(3000);
    if (!report.sentryFlushed) {
      // The SDK client is not active in this step (measured: flush false while the ingest endpoint
      // answers 200), so its event never leaves. Send the real failure straight to the ingest endpoint.
      const direct = await probeSentry(process.env.SENTRY_DSN, timedFetch('sentry.direct'), {
        message: `job failed: ${def.id}`,
        errorName: error.name,
        errorMessage: message,
        tags: { job: def.id, group },
        extra: { instanceId: runId, triggeringEvent: event.name },
        environment: process.env.NODE_ENV,
      });
      report.sentryProbe = direct;
      if ('status' in direct && direct.status === 200 && direct.eventId) {
        report.sentryEventId = direct.eventId;
      }
    }
  } catch (err) {
    logger.warn({ err, job: def.id }, '[jobs] failure not sent to sentry');
  }
  logger.error(
    {
      job: def.id,
      group,
      instanceId: runId,
      alert: report.alert,
      sentryEventId: report.sentryEventId,
      sentryFlushed: report.sentryFlushed,
      sentryProbeStatus:
        report.sentryProbe && 'status' in report.sentryProbe ? report.sentryProbe.status : null,
    },
    '[jobs] final failure reported'
  );
  return report;
}
