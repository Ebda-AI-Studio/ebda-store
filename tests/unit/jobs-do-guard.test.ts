/**
 * INFRA-CF-1 PR E (Ruling CF-JOBS-1): background jobs and the stores that live on their Durable Object.
 *  - the classification covers every job and defaults to the safe class;
 *  - while JOBS_ON_DO is off NOTHING changes;
 *  - an unported job for a DO store is refused (alert, P0 for money), by both runners, and never runs its handler;
 *  - sweeps skip DO stores; a ported job reads through storeDb (the DO for a DO store, Postgres tenant scope otherwise);
 *  - alarms are armed for DO stores only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';
import { MONEY_JOBS, NO_STORE_DATA_JOBS, PORTED_JOBS, jobDataClass } from '@api/lib/jobs/job-data';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { runJobWorkflow } from '@api/lib/jobs/run-workflow';
import { handleJobsBatch, type QueueMessageLike } from '@api/lib/jobs/run-queue';
import { decideRun, doStoreIds, guardedRun, jobTargetStore } from '@api/lib/jobs/do-guard';
import type { WorkflowStepLike } from '@api/lib/jobs/step-adapter';

const { sendAlert, runInStoreScope, repo, hidden } = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => 'sent'),
  runInStoreScope: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
  repo: { backend: 'pg' as 'pg' | 'do', counts: [] as Array<{ storeId: string }> },
  hidden: { calls: [] as string[] },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  runInStoreScope,
}));
vi.mock('@api/lib/repo-factory', () => ({
  runInJobRepoScope: <T>(fn: () => T) => fn(),
  storeRepo: async (storeId: string) => ({
    storeId,
    backend: repo.backend,
    db: {
      wholesaleApplication: {
        count: async (a: { where: { storeId: string } }) => {
          repo.counts.push({ storeId: a.where.storeId });
          return 3;
        },
      },
    },
  }),
}));
const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@api/lib/wholesale-merchant-notify', () => ({ notifyMerchantOfApplications: notify }));

class NonRetryable extends Error {}
const wfCalls: string[] = [];
const wf: WorkflowStepLike = {
  async do(name, _c, cb) {
    wfCalls.push(`do:${name}`);
    return cb();
  },
  async sleep(name) {
    wfCalls.push(`sleep:${name}`);
  },
  async sleepUntil() {},
};
const wfArgs = (fn: string, data: Record<string, unknown>) => ({
  params: { fn, event: { name: 'x/y', id: 'e1', data } } as never,
  instanceId: 'inst-1',
  step: wf,
  withContext: <T>(f: () => Promise<T>) => f(),
  NonRetryable,
});
const qmsg = (fn: string, data: Record<string, unknown>) => {
  const m = {
    id: 'm1',
    attempts: 1,
    body: { kind: 'job', fn, event: { name: 'x/y', id: 'e1', data } },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return m as typeof m & QueueMessageLike;
};

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const PG_STORE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.unstubAllEnvs();
  sendAlert.mockClear();
  runInStoreScope.mockClear();
  notify.mockClear();
  repo.backend = 'pg';
  repo.counts = [];
  hidden.calls = [];
  wfCalls.length = 0;
  clearJobRegistry();
  setCfBindings({
    JOBS_QUEUE: { send: vi.fn(async () => undefined) },
    JOBS_WORKFLOW: { create: async () => ({ id: 'i' }) },
  } as never);
});
afterEach(() => {
  clearCfBindings();
  vi.unstubAllEnvs();
});
const flagOn = () => {
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
};

describe('job data classification', () => {
  it('names only real jobs, the sets are disjoint, and everything else is the safe default', () => {
    for (const set of [NO_STORE_DATA_JOBS, PORTED_JOBS, MONEY_JOBS])
      for (const id of set) expect(JOBS_MAP[id], `${id} is not in JOBS_MAP`).toBeDefined();
    for (const id of PORTED_JOBS) expect(NO_STORE_DATA_JOBS.has(id)).toBe(false);
    for (const id of MONEY_JOBS) {
      expect(NO_STORE_DATA_JOBS.has(id) || PORTED_JOBS.has(id)).toBe(false);
    }
    for (const id of Object.keys(JOBS_MAP)) {
      const c = jobDataClass(id);
      expect(['none', 'ported', 'unported']).toContain(c);
      if (!NO_STORE_DATA_JOBS.has(id) && !PORTED_JOBS.has(id)) expect(c).toBe('unported');
    }
  });

  it('every group-7 money job is a MONEY job (a new money job cannot silently page P1)', () => {
    for (const [id, e] of Object.entries(JOBS_MAP))
      if (e.group === '7-money' && !NO_STORE_DATA_JOBS.has(id))
        expect(MONEY_JOBS.has(id), `${id} is group 7-money but not in MONEY_JOBS`).toBe(true);
  });

  it('a ported job really goes through storeDb (the claim is checked against its source)', () => {
    const src = readFileSync(
      new URL(
        '../../apps/api/src/lib/inngest/functions/wholesale-pending-nudge.ts',
        import.meta.url
      ),
      'utf8'
    );
    expect(src).toMatch(/withStoreDb\(/);
    expect(src).not.toMatch(/withStore\(/);
    expect(src).not.toMatch(/\bprisma\b/);
  });
});

describe('with JOBS_ON_DO off (today) nothing changes', () => {
  it('no store is a DO store, every decision is "run", guardedRun is a pass-through', async () => {
    vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE); // the Phase 0 spike flag alone must not touch jobs
    expect(doStoreIds().size).toBe(0);
    registerJob({ id: 'payment-webhook-process' }, async () => 1);
    const def = { id: 'payment-webhook-process', options: { id: 'x' }, handler: async () => 1 };
    expect(decideRun(def, { name: 'a', data: { storeId: DO_STORE } })).toEqual({ run: true });
    expect(await guardedRun(def, { name: 'a' }, async () => 42)).toBe(42);
  });
});

describe('refusal of unported jobs for a DO store', () => {
  it('the target store is the alarm store, else event.data.storeId', () => {
    expect(jobTargetStore({ name: 'a', data: { alarm: true, storeId: 's' } })).toBe('s');
    expect(jobTargetStore({ name: 'a', data: { storeId: 't' } })).toBe('t');
    expect(jobTargetStore({ name: 'a', data: { storeId: 7 } })).toBeUndefined();
    expect(jobTargetStore({ name: 'a' })).toBeUndefined();
  });

  it('queue runner: a money job for a DO store is NOT run, pages P0, is acked, and skips its onFailure', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    const onFailure = vi.fn();
    registerJob({ id: 'order-auto-cancel-unpaid', onFailure }, handler);
    const m = qmsg('order-auto-cancel-unpaid', { storeId: DO_STORE });
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });
    expect(handler).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p0', source: 'jobs-do-guard' })
    );
  });

  it('queue runner: a non-money unported job pages P1; the same job for a Postgres store runs normally', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'bulk-ai-seo' }, handler);
    await handleJobsBatch({
      queue: 'ebda-jobs',
      messages: [qmsg('bulk-ai-seo', { storeId: DO_STORE })],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
    sendAlert.mockClear();
    const m = qmsg('bulk-ai-seo', { storeId: PG_STORE });
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('workflow runner: refused before any step body, alert sent in its own step', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'payment-webhook-process' }, handler);
    await runJobWorkflow(wfArgs('payment-webhook-process', { storeId: DO_STORE }));
    expect(handler).not.toHaveBeenCalled();
    expect(wfCalls).toEqual(['do:do-guard-refusal']);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p0' }));
  });

  it('an alarm run for a DO store is refused the same way; a platform ("none") job is never refused', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'accounting-daily-close' }, handler);
    await runJobWorkflow(wfArgs('accounting-daily-close', { alarm: true, storeId: DO_STORE }));
    expect(handler).not.toHaveBeenCalled();
    const none = vi.fn(async () => 1);
    registerJob({ id: 'billing-renewal-daily' }, none);
    await runJobWorkflow(wfArgs('billing-renewal-daily', { storeId: DO_STORE }));
    expect(none).toHaveBeenCalledTimes(1);
  });

  it('a ported job is NOT refused for a DO store', () => {
    flagOn();
    const def = {
      id: 'wholesale-pending-nudge-cron',
      options: { id: 'x' },
      handler: async () => 1,
    };
    expect(decideRun(def, { name: 'a', data: { alarm: true, storeId: DO_STORE } })).toEqual({
      run: true,
    });
  });
});

describe('sweeps skip DO stores, loudly for an unported job', () => {
  it('guardedRun hides DO stores from storeDirectory/acrossStores and alerts once for an unported sweep', async () => {
    flagOn();
    const { dropHiddenStores } = await import('@ebda/database');
    const def = { id: 'data-retention', options: { id: 'x' }, handler: async () => 1 };
    const seen = await guardedRun(def, { name: 'cron' }, async () =>
      dropHiddenStores([{ id: DO_STORE }, { id: PG_STORE }], s => s.id, 'storeDirectory')
    );
    expect(seen.map(s => s.id)).toEqual([PG_STORE]);
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'jobs-do-guard',
        title: expect.stringContaining('skipped 1 DO store'),
      })
    );
  });

  it('a ported alarm run for store S can still list S (its alarm owns it) but no other DO store', async () => {
    flagOn();
    vi.stubEnv('STORE_DO_ENABLED_IDS', `${DO_STORE},22222222-2222-4222-8222-222222222222`);
    const { dropHiddenStores } = await import('@ebda/database');
    const def = {
      id: 'wholesale-pending-nudge-cron',
      options: { id: 'x' },
      handler: async () => 1,
    };
    const seen = await guardedRun(
      def,
      { name: 'a', data: { alarm: true, storeId: DO_STORE } },
      async () =>
        dropHiddenStores(
          [{ id: DO_STORE }, { id: '22222222-2222-4222-8222-222222222222' }, { id: PG_STORE }],
          s => s.id,
          'storeDirectory'
        )
    );
    expect(seen.map(s => s.id)).toEqual([DO_STORE, PG_STORE]);
    expect(sendAlert).not.toHaveBeenCalled(); // ported: silent
  });
});

describe('the ported job (wholesale-pending-nudge-cron) follows the store backend', () => {
  it('DO store: counts come from the DO client, no Postgres tenant scope is opened', async () => {
    const { nudgeStore } = await import('@api/lib/inngest/functions/wholesale-pending-nudge');
    repo.backend = 'do';
    expect(await nudgeStore(DO_STORE, new Date('2026-10-29T00:00:00Z'))).toBe(3);
    expect(repo.counts).toEqual([{ storeId: DO_STORE }, { storeId: DO_STORE }]);
    expect(runInStoreScope).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(DO_STORE, 'nudge', { pendingCount: 3 });
  });

  it('Postgres store: the same reads run inside the store tenant scope, as before', async () => {
    const { nudgeStore } = await import('@api/lib/inngest/functions/wholesale-pending-nudge');
    repo.backend = 'pg';
    expect(await nudgeStore(PG_STORE)).toBe(3);
    expect(runInStoreScope).toHaveBeenCalledTimes(1);
    expect(runInStoreScope.mock.calls[0][0]).toBe(PG_STORE);
  });
});
