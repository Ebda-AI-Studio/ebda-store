/** The shared AI-sweep starter (routes/ai.routes.ts and the assistant tools): queue-then-send fails fast (Ruling JOBS-ORPHAN-1). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), markFailed: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({
  storeWriter: async () => ({ bulkAiJob: { create: m.create } }),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: m.send } }));
vi.mock('@api/lib/jobs/enqueue-fail', () => ({ markJobFailedOnEnqueueError: m.markFailed }));

import { BulkAiEnqueueError, enqueueBulkAiJob } from '@api/services/bulk-ai-job.service';

beforeEach(() => {
  m.create.mockReset().mockResolvedValue({ id: 'j1', status: 'queued', kind: 'seo', createdAt: 1 });
  m.send.mockReset().mockResolvedValue(undefined);
  m.markFailed.mockReset().mockResolvedValue(undefined);
});

describe('enqueueBulkAiJob', () => {
  it('creates the row then sends the matching event', async () => {
    await enqueueBulkAiJob('s1', 'u1', { kind: 'translate', direction: 'to_ar' });
    expect(m.create.mock.calls[0]![0].data).toMatchObject({
      storeId: 's1',
      userId: 'u1',
      kind: 'translate',
      direction: 'to_ar',
    });
    expect(m.send).toHaveBeenCalledWith({
      name: 'bulk-ai/translate-requested',
      data: { jobId: 'j1', storeId: 's1', direction: 'to_ar' },
    });
    // translate is fill-only for every caller (NEVER-OVERWRITE-1): `force` never reaches the row or the event
    await enqueueBulkAiJob('s1', 'u1', {
      kind: 'translate',
      direction: 'to_en',
      force: true,
    } as never);
    expect(m.create.mock.calls[1]![0].data).not.toHaveProperty('force');
    expect(m.send.mock.calls[1]![0].data).toEqual({
      jobId: 'j1',
      storeId: 's1',
      direction: 'to_en',
    });
    await enqueueBulkAiJob('s1', 'u1', { kind: 'llms_txt', force: true });
    expect(m.send.mock.calls[2]![0]).toEqual({
      name: 'bulk-ai/llms-txt-requested',
      data: { jobId: 'j1', storeId: 's1', force: true },
    });
  });
  it('marks the row failed and raises when the send throws (never an orphan queued row)', async () => {
    m.send.mockImplementation(() => Promise.reject(new Error('queue down')));
    const e = await enqueueBulkAiJob('s1', 'u1', { kind: 'seo' }).then(
      () => null,
      (x: unknown) => x
    );
    expect(e).toBeInstanceOf(BulkAiEnqueueError);
    expect(m.markFailed).toHaveBeenCalledWith('s1', 'j1', expect.any(Error));
  });
});
