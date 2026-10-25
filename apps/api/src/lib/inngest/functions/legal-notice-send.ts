import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import logger from '../../logger';
import { sendAlert } from '../../../services/alerts.service';
import {
  LEGAL_NOTICE_MAX_BATCH_STEPS,
  failQueuedDeliveries,
  materializeDeliveries,
  sendNextBatch,
} from '../../../services/legal-notice.service';
import { legalNoticeMailerReady } from '../../../services/platform-mailer';

/**
 * Material policy-change email fan-out (Ruling LEGAL-4). Triggered ONLY by
 * `legal/notice.send-requested`, which only the super-admin Policy updates routes emit
 * (Send notice, Resume, Retry failed).
 *
 * Invariants:
 *  - one email per recipient per version: delivery rows are UNIQUE(user, doc, version) and
 *    are claimed queued -> sending before the send (legal-notice.service.ts sendNextBatch);
 *  - a run is pinned to ONE send row (`sendId`, M1); recipients are materialised only once
 *    (recipient_count), so Resume / Retry failed re-use the same rows (I5);
 *  - the mailer is checked ONCE before the first batch: unconfigured -> every queued row is
 *    failed (RESEND_NOT_CONFIGURED) and a P1 raised, no pacer slot burnt (I2);
 *  - throttled by the platform send pacer (shared Resend budget). A step waits for a slot
 *    only within its wall-clock budget; otherwise it ends and the next step continues;
 *  - no orphan `queued` rows: the step cap fails the rest (SEND_WINDOW_EXHAUSTED, P1 alert)
 *    and onFailure fails the rest if the whole job dies (SEND_JOB_FAILED);
 *  - any failed delivery in the run raises a P1 with the count (no addresses) (I2);
 *  - every DB call acts as `sentBy` (asPlatformOperator): the active super_admin acting for
 *    this run.
 */
type SendData = { sendId?: string; docKey?: string; version?: string; sentBy?: string };
type StepLike = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };

const RECOVER = 'docs/runbooks/legal-policy-change.md § Recover a stalled or failed run';

export async function runLegalNoticeSend({
  event,
  step,
}: {
  event: { data?: SendData };
  step: StepLike;
}) {
  const { sendId, docKey, version, sentBy } = event.data ?? {};
  if (!sendId || !docKey || !version || !sentBy) {
    logger.warn('[LEGAL-NOTICE] send-requested without sendId/docKey/version/sentBy, skipping');
    return { skipped: 'missing-data' };
  }
  const m = await step.run('materialize', () =>
    materializeDeliveries(sentBy, sendId, docKey, version)
  );
  if (!m.ok) return { skipped: m.reason };

  const preflight = await step.run('preflight', async () => {
    if (legalNoticeMailerReady()) return { ready: true, failed: 0 };
    const n = await failQueuedDeliveries(sentBy, docKey, version, 'RESEND_NOT_CONFIGURED');
    logger.error({ docKey, version, failed: n }, '[LEGAL-NOTICE] mailer not configured');
    await sendAlert({
      level: 'p1',
      source: 'legal.notice.mailer_not_configured',
      title: `Legal notice ${docKey}@${version}: email is not configured, nobody was mailed`,
      body:
        `RESEND_API_KEY is missing in production. ${n} recipient(s) of the ${docKey}@${version} ` +
        `policy notice were marked failed (RESEND_NOT_CONFIGURED) and NOT emailed. Fix the key, ` +
        `then press "Retry failed" on Policy updates (${RECOVER}).`,
      context: { docKey, version, failed: n },
    }).catch(() => undefined);
    return { ready: false, failed: n };
  });
  if (!preflight.ready) {
    return {
      recipientCount: m.recipientCount,
      sent: 0,
      failed: preflight.failed,
      stranded: 0,
      skipped: 'RESEND_NOT_CONFIGURED',
    };
  }

  let sent = 0;
  let failed = 0;
  let remaining = m.queued;
  // A deferred step (no pacer slot inside its budget) sends fewer than a batch, so the
  // bound is on steps, not on recipientCount / batch size.
  for (let i = 0; i < LEGAL_NOTICE_MAX_BATCH_STEPS && remaining > 0; i++) {
    const r = await step.run(`batch-${i}`, () => sendNextBatch(sentBy, docKey, version));
    sent += r.sent;
    failed += r.failed;
    remaining = r.remaining;
  }
  let stranded = 0;
  if (remaining > 0) {
    stranded = await step.run('fail-leftover', () =>
      failQueuedDeliveries(sentBy, docKey, version, 'SEND_WINDOW_EXHAUSTED')
    );
  }
  if (stranded > 0) {
    await step.run('alert-stranded', async () => {
      logger.error({ docKey, version, stranded }, '[LEGAL-NOTICE] recipients never mailed');
      await sendAlert({
        level: 'p1',
        source: 'legal.notice.window_exhausted',
        title: `Legal notice ${docKey}@${version} ended with store owners never mailed`,
        body:
          `${stranded} recipient(s) of the ${docKey}@${version} policy notice were still queued ` +
          `after ${LEGAL_NOTICE_MAX_BATCH_STEPS} batch steps. They are marked failed ` +
          `(SEND_WINDOW_EXHAUSTED) and were NOT emailed. Press "Retry failed" (${RECOVER}).`,
        context: { docKey, version, stranded },
      }).catch(() => undefined);
      return null;
    });
  }
  if (failed > 0) {
    await step.run('alert-failures', async () => {
      logger.error({ docKey, version, failed }, '[LEGAL-NOTICE] deliveries failed');
      await sendAlert({
        level: 'p1',
        source: 'legal.notice.failures',
        title: `Legal notice ${docKey}@${version}: ${failed} email(s) failed`,
        body:
          `${failed} delivery(ies) of the ${docKey}@${version} policy notice failed in this run. ` +
          `The reasons are on the Policy updates page; press "Retry failed" once the cause is ` +
          `fixed (${RECOVER}).`,
        context: { docKey, version, failed },
      }).catch(() => undefined);
      return null;
    });
  }
  logger.info(
    { docKey, version, recipientCount: m.recipientCount, sent, failed, stranded },
    '[LEGAL-NOTICE] done'
  );
  return { recipientCount: m.recipientCount, sent, failed, stranded };
}

/**
 * The whole job died (retries exhausted). Fail what is still queued for THIS send row, so the
 * page shows it and "Retry failed" can pick it up. If that itself fails (e.g. `sentBy` was
 * demoted, so asPlatformOperator refuses), the rows stay `queued` and a P1 names the document
 * and the recovery procedure (M2); the generic Inngest-failure P1 carries no such context.
 */
export async function onLegalNoticeSendFailure(d: SendData): Promise<void> {
  if (!d.sendId || !d.docKey || !d.version || !d.sentBy) return;
  try {
    const n = await failQueuedDeliveries(
      d.sentBy,
      d.docKey,
      d.version,
      'SEND_JOB_FAILED',
      d.sendId
    );
    logger.error(
      { docKey: d.docKey, version: d.version, sentBy: d.sentBy, marked: n },
      '[LEGAL-NOTICE] send job failed'
    );
  } catch (err) {
    logger.error(
      { err, docKey: d.docKey, version: d.version },
      '[LEGAL-NOTICE] send job failed and its queued rows could not be marked'
    );
    await sendAlert({
      level: 'p1',
      source: 'legal.notice.job_failed',
      title: `Legal notice ${d.docKey}@${d.version}: email run failed, rows left queued`,
      body:
        `The ${d.docKey}@${d.version} notice job failed and its still-queued deliveries could ` +
        `not be marked failed (${String((err as Error)?.message ?? err).slice(0, 200)}). ` +
        `Press "Resume" on Policy updates as an active super admin (${RECOVER}).`,
      context: { docKey: d.docKey, version: d.version },
    }).catch(() => undefined);
  }
}

const legalNoticeSendFn = inngest.createFunction(
  {
    id: 'legal-notice-send',
    name: 'Legal: email a material policy change to every store owner',
    concurrency: { limit: 1 },
    retries: 4,
    triggers: [{ event: 'legal/notice.send-requested' }],
    onFailure: async ({ event }) =>
      onLegalNoticeSendFailure((event?.data?.event?.data ?? {}) as SendData),
  },
  async ({ event, step }) =>
    runLegalNoticeSend({ event: event as { data?: SendData }, step: step as unknown as StepLike })
);

export const legalNoticeSend: JobDef = legalNoticeSendFn;
