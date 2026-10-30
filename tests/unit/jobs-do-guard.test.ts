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
import {
  EVENT_STORE_RESOLVERS,
  decideRun,
  doStoreIds,
  guardedRun,
  jobTargetStore,
  needsStoreLookup,
  resolveRunStore,
} from '@api/lib/jobs/do-guard';
import type { WorkflowStepLike } from '@api/lib/jobs/step-adapter';

const { sendAlert, runInStoreScope, repo, hidden } = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => 'sent'),
  runInStoreScope: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
  repo: { backend: 'pg' as 'pg' | 'do', counts: [] as Array<{ storeId: string }> },
  hidden: { calls: [] as string[] },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));
const inbox = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@api/lib/definer', () => ({ webhookInbox: inbox }));
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

// payment-webhook-process (the only production resolver) is ported (Ruling CF-JOBS-4), so the resolver mechanism is exercised
// with a still-unported money job: its event names the store through an inbox-like row.
EVENT_STORE_RESOLVERS['order-created-fanout'] = async event => {
  const id = event.data?.webhookEventId;
  if (typeof id !== 'string' || !id) return undefined;
  return ((await inbox.get(id)) as { storeId?: string | null } | undefined)?.storeId ?? undefined;
};

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
      if (e.group === '7-money' && !NO_STORE_DATA_JOBS.has(id) && !PORTED_JOBS.has(id))
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

  it('the abandoned-cart jobs (ported in CF-R4-5) reach their rows through the store repo, never `prisma.abandonedCart`', () => {
    const read = (f: string) =>
      readFileSync(new URL(`../../apps/api/src/${f}`, import.meta.url), 'utf8');
    for (const f of [
      'services/cart-recovery-email.service.ts',
      'lib/inngest/functions/cart-recovery-email.ts',
    ]) {
      const src = read(f);
      expect(src).toMatch(/storeRepo\(/);
      expect(src).not.toMatch(/prisma\.(abandonedCart|newsletterSubscriber|cartItem|cartBundle)/);
    }
    const retention = read('lib/inngest/functions/data-retention.ts');
    expect(retention).not.toMatch(/prisma\.abandonedCart/);
    expect(PORTED_JOBS.has('cart-recovery-email')).toBe(true);
    expect(PORTED_JOBS.has('abandoned-cart-purge-weekly')).toBe(true);
  });

  it('the status-fanout sweep (ported in CF-PAY-1) reads through storeDb and writes a DO order only through the money op', () => {
    const src = readFileSync(
      new URL(
        '../../apps/api/src/lib/inngest/functions/order-status-fanout-stuck-sweep.ts',
        import.meta.url
      ),
      'utf8'
    );
    expect(src).toMatch(/sweepStoresDb\(/); // reads through the store's backend (CF-JOBS-4: the DO store's alarm)
    expect(src).toMatch(/fanoutDisarm\(/);
    expect(src).not.toMatch(/\bprisma\b/);
    // the one Postgres write left is the pg branch of the disarm, reached only when storeMoney() is null
    expect(src.match(/withStore\(/g)).toHaveLength(1);
    expect(src.indexOf('fanoutDisarm(')).toBeLessThan(src.indexOf('withStore('));
  });
});

describe('with JOBS_ON_DO off (today) nothing changes', () => {
  it('no store is a DO store, every decision is "run", guardedRun is a pass-through', async () => {
    vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE); // the Phase 0 spike flag alone must not touch jobs
    expect(doStoreIds().size).toBe(0);
    registerJob({ id: 'order-created-fanout' }, async () => 1);
    const def = { id: 'order-created-fanout', options: { id: 'x' }, handler: async () => 1 };
    expect(decideRun(def, { name: 'a', data: { storeId: DO_STORE } })).toEqual({ run: true });
    expect(await guardedRun(def, { name: 'a' }, async () => 42)).toBe(42);
  });
});

describe('events that carry no storeId (PR E residual)', () => {
  it('every typed event either carries a required storeId or is on the reviewed list (a new one fails here)', () => {
    const src = readFileSync('apps/api/src/lib/inngest/client.ts', 'utf8');
    const noStore: string[] = [];
    for (const m of src.matchAll(/name: '([^']+)';\s*data:\s*(\{[\s\S]*?\n\s*\};|\{[^\n]*\};)/g)) {
      if (!/\bstoreId: string/.test(m[2])) noStore.push(m[1]);
    }
    // payment/webhook.received is ported (its job reads the inbox row's store); the others touch no store data.
    // Anything new needs a required storeId or a resolver.
    expect(noStore.sort()).toEqual([
      'contact/form.submitted', // storeId optional; without one the message is dropped (no store data read)
      'ebda-ads/conversion.requested', // Ebda's own ad conversion: platform, no store
      'legal/notice.send-requested',
      'payment/webhook.received',
    ]);
  });
  it('payment-webhook-process resolves its store from the inbox row: a DO store is refused (P0), a Postgres store runs', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'order-created-fanout' }, handler);
    inbox.get.mockResolvedValueOnce({ storeId: DO_STORE });
    const m = qmsg('order-created-fanout', { webhookEventId: 'wh1', provider: 'paymob' });
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });
    expect(handler).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p0' }));

    sendAlert.mockClear();
    inbox.get.mockResolvedValueOnce({ storeId: 'some-postgres-store' });
    await handleJobsBatch({
      queue: 'ebda-jobs',
      messages: [qmsg('order-created-fanout', { webhookEventId: 'wh2', provider: 'paymob' })],
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });
  it('a row with no store, a missing id or a failed lookup runs as the platform-only path (no DO store reachable)', async () => {
    flagOn();
    const def = { id: 'order-created-fanout', options: { id: 'x' }, handler: async () => 1 };
    inbox.get.mockResolvedValueOnce({ storeId: null });
    expect(
      await resolveRunStore(def, { name: 'a', data: { webhookEventId: 'w' } })
    ).toBeUndefined();
    expect(await resolveRunStore(def, { name: 'a', data: {} })).toBeUndefined();
    inbox.get.mockRejectedValueOnce(new Error('db down'));
    expect(
      await resolveRunStore(def, { name: 'a', data: { webhookEventId: 'w' } })
    ).toBeUndefined();
  });
  it('with JOBS_ON_DO off the inbox is never read', async () => {
    const def = { id: 'order-created-fanout', options: { id: 'x' }, handler: async () => 1 };
    inbox.get.mockClear();
    expect(needsStoreLookup(def, { name: 'a', data: { webhookEventId: 'w' } })).toBe(false);
    expect(
      await resolveRunStore(def, { name: 'a', data: { webhookEventId: 'w' } })
    ).toBeUndefined();
    expect(inbox.get).not.toHaveBeenCalled();
  });
  it('the Workflow runner looks the store up in its own step and refuses a DO store', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'order-created-fanout' }, handler);
    inbox.get.mockResolvedValueOnce({ storeId: DO_STORE });
    wfCalls.length = 0;
    await runJobWorkflow(wfArgs('order-created-fanout', { webhookEventId: 'w' }));
    expect(handler).not.toHaveBeenCalled();
    expect(wfCalls).toContain('do:resolve-run-store');
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
    registerJob({ id: 'order-created-fanout', onFailure }, handler);
    const m = qmsg('order-created-fanout', { storeId: DO_STORE });
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
    registerJob({ id: 'order-created-fanout' }, handler);
    await runJobWorkflow(wfArgs('order-created-fanout', { storeId: DO_STORE }));
    expect(handler).not.toHaveBeenCalled();
    expect(wfCalls).toEqual(['do:do-guard-refusal']);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p0' }));
  });

  it('an alarm run for a DO store is refused the same way; a platform ("none") job is never refused', async () => {
    flagOn();
    const handler = vi.fn(async () => 1);
    registerJob({ id: 'order-status-changed-fanout' }, handler);
    await runJobWorkflow(wfArgs('order-status-changed-fanout', { alarm: true, storeId: DO_STORE }));
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
