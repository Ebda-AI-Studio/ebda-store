/**
 * Ruling JOBS-ORPHAN-1 (defect 3): a stale `queued` row gets ONE re-dispatch (auto_resume_count), is then
 * marked failed ('never started') with a SINGLE alert, and the alert text is Cloudflare advice (no Inngest).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockSendAlert, mockUpdateMany, state } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSendAlert: vi.fn(),
  mockUpdateMany: vi.fn(),
  state: { queued: [] as unknown[], running: [] as unknown[], call: 0 },
}));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: mockSend,
    createFunction: (opts: unknown, handler: unknown) => ({
      id: 'queue-depth-watch',
      options: opts,
      handler,
    }),
  },
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  // the watcher reads queued first, then running
  sweepStoresDb: async () => (state.call++ % 2 === 0 ? state.queued : state.running),
  withStoreRw: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ bulkAiJob: { updateMany: mockUpdateMany, update: mockUpdateMany } }),
}));
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => ({ name: 'QA Store', slug: 'qa' }) } }),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn(), isAiQuotaCapError: () => false }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { queueDepthWatch } from '@api/lib/inngest/functions/queue-depth-watch';

const run = () =>
  (queueDepthWatch.handler as (ctx: unknown) => Promise<Record<string, number>>)({
    event: { data: {} },
  });

const queuedJob = (autoResumeCount: number, kind = 'recommendations') => ({
  id: 'job-1',
  storeId: 'store-1',
  kind,
  createdAt: new Date(Date.now() - 44 * 3600_000),
  force: false,
  direction: null,
  autoResumeCount,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.call = 0;
  state.running = [];
  mockSend.mockResolvedValue(undefined);
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('queue-depth-watch: stale queued rows', () => {
  it('re-dispatches a never-started job ONCE, counts it, and does not alert yet', async () => {
    state.queued = [queuedJob(0)];
    const out = await run();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoResumeCount: { increment: 1 } } })
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'bulk-ai/recommendations-requested',
        data: expect.objectContaining({ jobId: 'job-1', storeId: 'store-1' }),
      })
    );
    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(out.queuedResent).toBe(1);
  });

  it('still queued after the resend -> marked failed "never started" + exactly one alert, no second send', async () => {
    state.queued = [queuedJob(1)];
    const out = await run();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', errorMessage: 'never started' }),
      })
    );
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(out.queuedFailed).toBe(1);
  });

  it('the alert is Cloudflare advice: names JOBS_WORKFLOW / JOBS_QUEUE and the job id, no Inngest / re-PUT', async () => {
    state.queued = [queuedJob(1)];
    await run();

    const alert = mockSendAlert.mock.calls[0][0] as { source: string; title: string; body: string };
    const text = `${alert.title} ${alert.body} ${alert.source}`;
    expect(text).not.toMatch(/inngest/i);
    expect(text).not.toMatch(/re-PUT/);
    expect(alert.source).toBe('jobs.queue-depth');
    expect(alert.body).toContain('JOBS_WORKFLOW');
    expect(alert.body).toContain('JOBS_QUEUE');
    expect(alert.body).toContain('job-1');
  });

  it('a failed re-dispatch falls straight to failed + one alert', async () => {
    state.queued = [queuedJob(0)];
    mockSend.mockRejectedValue(new Error('no runner'));
    const out = await run();

    expect(out.queuedFailed).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('a kind with no resend mapping is failed directly', async () => {
    state.queued = [queuedJob(0, 'mystery_kind')];
    await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('a row that started meanwhile (claim matches 0 rows) is left alone', async () => {
    state.queued = [queuedJob(0)];
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});
