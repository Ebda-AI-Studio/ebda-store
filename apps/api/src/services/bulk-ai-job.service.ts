/**
 * Starts a catalogue-wide AI sweep (translate / SEO / llms.txt): creates the `BulkAiJob` row, then sends its start event. The one starter:
 * the three `POST /stores/:storeId/ai/bulk/*` routes (routes/ai.routes.ts) and the assistant's AI-job tools both call it.
 * Queue-then-send fails fast (Ruling JOBS-ORPHAN-1): when the send throws, the row is marked `failed` (never left an orphan `queued`) and
 * `BulkAiEnqueueError` is raised so the caller answers "could not enqueue".
 */
import { inngest } from '../lib/inngest/client';
import { markJobFailedOnEnqueueError } from '../lib/jobs/enqueue-fail';
import { storeWriter } from '../lib/repo-factory';

export type BulkAiJobSpec =
  | { kind: 'translate'; direction: 'to_ar' | 'to_en' }
  | { kind: 'seo'; force?: boolean }
  | { kind: 'llms_txt'; force?: boolean };

type BulkAiJobRow = { id: string; status: string; kind: string; createdAt: Date };

export class BulkAiEnqueueError extends Error {
  constructor(readonly jobId: string) {
    super('Could not enqueue the AI job');
    this.name = 'BulkAiEnqueueError';
  }
}

export async function enqueueBulkAiJob(
  storeId: string,
  userId: string,
  spec: BulkAiJobSpec
): Promise<BulkAiJobRow> {
  const force = spec.kind !== 'translate' && spec.force === true;
  const job = await (
    await storeWriter(storeId)
  ).bulkAiJob.create({
    data: {
      storeId,
      userId,
      kind: spec.kind,
      ...(spec.kind === 'translate' ? { direction: spec.direction } : {}),
      ...(force ? { errors: { force: true } as object } : {}),
      // the durable copy the stuck-job watcher resumes from (a replace run must stay a replace run)
      ...(force ? { force: true } : {}),
    },
    select: { id: true, status: true, kind: true, createdAt: true },
  });
  try {
    await inngest.send(
      spec.kind === 'translate'
        ? {
            name: 'bulk-ai/translate-requested',
            data: { jobId: job.id, storeId, direction: spec.direction },
          }
        : {
            name: spec.kind === 'seo' ? 'bulk-ai/seo-requested' : 'bulk-ai/llms-txt-requested',
            data: { jobId: job.id, storeId, force },
          }
    );
  } catch (err) {
    await markJobFailedOnEnqueueError(storeId, job.id, err);
    throw new BulkAiEnqueueError(job.id);
  }
  return job as BulkAiJobRow;
}
