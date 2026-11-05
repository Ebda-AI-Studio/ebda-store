/**
 * Queue-then-send fails fast (Ruling JOBS-ORPHAN-1): a job row is created `queued`, then its start
 * event is sent. When the send throws, nothing will ever pick the row up, so it is marked `failed`
 * here instead of lingering as an orphan `queued` row. Best-effort: never throws.
 */
import { storeWriter } from '../repo-factory';
import { withSavepoint } from '../savepoint';
import { AppError } from '../../middleware/error-handler';
import logger from '../logger';

export type EnqueueJobTable = 'bulkAiJob' | 'bulkImportJob';

export async function markJobFailedOnEnqueueError(
  storeId: string,
  jobId: string,
  err: unknown,
  table: EnqueueJobTable = 'bulkAiJob'
): Promise<void> {
  const message = err instanceof AppError ? err.message : 'Failed to enqueue job';
  try {
    // Savepointed: best-effort inside a request's tenant transaction, so a swallowed failure
    // cannot abort it (issue 2215's class). A pass-through outside a tenant context.
    await withSavepoint(async () => {
      const w = await storeWriter(storeId);
      const data = { status: 'failed' as const, errorMessage: message, completedAt: new Date() };
      if (table === 'bulkImportJob') {
        await w.bulkImportJob.update({ where: { id: jobId, storeId }, data });
      } else {
        await w.bulkAiJob.update({ where: { id: jobId, storeId }, data });
      }
    });
  } catch (markErr) {
    logger.error(
      { err: markErr, jobId, storeId },
      '[jobs] could not mark the job failed after an enqueue error'
    );
  }
}
