import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import logger from '../../logger';
import { sendAlert } from '../../../services/alerts.service';
import {
  LEGAL_NOTICE_MAX_BATCH_STEPS,
  failQueuedDeliveries,
  materializeDeliveries,
  sendNextBatch,
} from '../../../services/legal-notice.service';

/**
 * Material policy-change email fan-out (Ruling LEGAL-4). Triggered ONLY by
 * `legal/notice.send-requested`, which only the super-admin
 * `POST /admin/legal-policies/:docKey/:version/send-notice` emits.
 *
 * Invariants:
 *  - one email per recipient per version: delivery rows are UNIQUE(user, doc, version) and
 *    are claimed queued -> sending before the send (legal-notice.service.ts sendNextBatch);
 *  - throttled by the platform send pacer (shared Resend budget). A step waits for a slot
 *    only within its wall-clock budget; otherwise it ends and the next step continues;
 *  - no orphan `queued` rows: the step cap fails the rest (SEND_WINDOW_EXHAUSTED, P1 alert)
 *    and onFailure fails the rest if the whole job dies (SEND_JOB_FAILED).
 *  - every DB call acts as `sentBy` (asPlatformOperator): an active super_admin.
 */
type SendData = { docKey?: string; version?: string; sentBy?: string };
type StepLike = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };

export async function runLegalNoticeSend({
  event,
  step,
}: {
  event: { data?: SendData };
  step: StepLike;
}) {
  const { docKey, version, sentBy } = event.data ?? {};
  if (!docKey || !version || !sentBy) {
    logger.warn('[LEGAL-NOTICE] send-requested without docKey/version/sentBy, skipping');
    return { skipped: 'missing-data' };
  }
  const m = await step.run('materialize', () => materializeDeliveries(sentBy, docKey, version));
  if (!m.ok) return { skipped: m.reason };
  let sent = 0;
  let failed = 0;
  let remaining = m.recipientCount;
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
        title: 'Legal notice ended with store owners never mailed',
        body:
          `${stranded} recipient(s) of the ${docKey}@${version} policy notice were still queued ` +
          `after ${LEGAL_NOTICE_MAX_BATCH_STEPS} batch steps. They are marked failed ` +
          `(SEND_WINDOW_EXHAUSTED) and were NOT emailed.`,
        context: { docKey, version, stranded },
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

const legalNoticeSendFn = inngest.createFunction(
  {
    id: 'legal-notice-send',
    name: 'Legal: email a material policy change to every store owner',
    concurrency: { limit: 1 },
    retries: 4,
    triggers: [{ event: 'legal/notice.send-requested' }],
    onFailure: async ({ event }) => {
      const d = (event?.data?.event?.data ?? {}) as SendData;
      if (!d.docKey || !d.version || !d.sentBy) return;
      const n = await failQueuedDeliveries(d.sentBy, d.docKey, d.version, 'SEND_JOB_FAILED');
      logger.error(
        { docKey: d.docKey, version: d.version, sentBy: d.sentBy, marked: n },
        '[LEGAL-NOTICE] send job failed'
      );
    },
  },
  async ({ event, step }) =>
    runLegalNoticeSend({ event: event as { data?: SendData }, step: step as unknown as StepLike })
);

export const legalNoticeSend: InngestFunction.Any = legalNoticeSendFn;
