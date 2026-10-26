/**
 * G5: `inngest.send` routing. A subscriber on a Cloudflare-enabled group starts a Workflow or a
 * queue message; the rest still go to Inngest; a failed start throws (so "enqueue failed -> mark
 * the row failed" callers keep working); a moved function is a no-op on the Inngest side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { dispatchEvents } from '@api/lib/jobs/dispatch';
import { groupEnabled, jobRunsOnCf } from '@api/lib/jobs/flag';
import { attachJobs } from '@api/lib/jobs/with-jobs';

const create = vi.fn(async (_o: { id: string; params: unknown }) => ({ id: 'i' }));
const qsend = vi.fn(async () => undefined);
const touch = vi.fn(async () => 'tok-1');

function bind() {
  setCfBindings({
    HYPERDRIVE: { connectionString: 'x' },
    JOBS_WORKFLOW: { create },
    JOBS_QUEUE: { send: qsend },
    JOB_GATE: { idFromName: (n: string) => n, get: () => ({ touch }) as never },
  });
}

const handler = async () => undefined;

beforeEach(() => {
  create.mockClear();
  qsend.mockClear();
  touch.mockClear();
  clearJobRegistry();
  // order/created: workflows in groups 6 and 3, a queue job in group 6. Ids are real JOBS_MAP keys.
  registerJob({ id: 'order-created-fanout', triggers: [{ event: 'order/created' }] }, handler);
  registerJob(
    { id: 'accounting-post-order-journal', triggers: [{ event: 'order/created' }] },
    handler
  );
  registerJob({ id: 'lifecycle-first-order', triggers: [{ event: 'order/created' }] }, handler);
  registerJob(
    {
      id: 'webhook-deliver',
      idempotency: 'event.data.deliveryId',
      triggers: [{ event: 'webhook/delivery.requested' }],
    },
    handler
  );
  registerJob(
    {
      id: 'search-product-index',
      debounce: { key: 'event.data.storeId', period: '20s', timeout: '2m' },
      triggers: [{ event: 'product.upserted' }],
    },
    handler
  );
  bind();
});
afterEach(() => {
  delete process.env.JOBS_CF_GROUPS;
  clearCfBindings();
});

const ev = { name: 'order/created', data: { storeId: 's1', orderId: 'o1' } };

describe('flag', () => {
  it('accepts group names, numbers and all', () => {
    process.env.JOBS_CF_GROUPS = '1, 3-books-stock';
    expect(groupEnabled('1-observability')).toBe(true);
    expect(groupEnabled('3-books-stock')).toBe(true);
    expect(groupEnabled('13-x')).toBe(false);
    expect(groupEnabled('2-housekeeping')).toBe(false);
    process.env.JOBS_CF_GROUPS = 'all';
    expect(groupEnabled('8-failure-watch')).toBe(true);
  });
  it('nothing runs on Cloudflare without the flag, or without the bindings (Node, tests)', () => {
    expect(jobRunsOnCf('order-created-fanout')).toBe(false);
    process.env.JOBS_CF_GROUPS = 'all';
    expect(jobRunsOnCf('order-created-fanout')).toBe(true);
    clearCfBindings();
    expect(jobRunsOnCf('order-created-fanout')).toBe(false);
    expect(jobRunsOnCf('not-in-the-map')).toBe(false);
  });
});

describe('dispatchEvents', () => {
  it('flag off: everything goes to Inngest, nothing starts on Cloudflare', async () => {
    const inngest = vi.fn(async () => ({ ids: ['a'] }));
    const r = await dispatchEvents(ev, inngest);
    expect(inngest).toHaveBeenCalledWith([ev]);
    expect(create).not.toHaveBeenCalled();
    expect(qsend).not.toHaveBeenCalled();
    expect(r).toEqual({ ids: ['a'] });
  });

  it('one group moved: its subscribers start (Workflow + queue message) AND the event still reaches Inngest for the rest', async () => {
    process.env.JOBS_CF_GROUPS = '6';
    const inngest = vi.fn(async () => ({ ids: [] }));
    await dispatchEvents(ev, inngest);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].params).toMatchObject({
      fn: 'order-created-fanout',
      event: { name: 'order/created' },
    });
    expect(qsend).toHaveBeenCalledTimes(1);
    expect(inngest).toHaveBeenCalledTimes(1);
  });

  it('every subscriber moved: Inngest is not called at all', async () => {
    process.env.JOBS_CF_GROUPS = '6,3';
    const inngest = vi.fn(async () => ({ ids: [] }));
    await dispatchEvents(ev, inngest);
    expect(create).toHaveBeenCalledTimes(2);
    expect(qsend).toHaveBeenCalledTimes(1);
    expect(inngest).not.toHaveBeenCalled();
  });

  it('an event nobody subscribes to still goes to Inngest', async () => {
    process.env.JOBS_CF_GROUPS = 'all';
    const inngest = vi.fn(async () => ({ ids: [] }));
    await dispatchEvents({ name: 'unknown/event' }, inngest);
    expect(inngest).toHaveBeenCalledTimes(1);
  });

  it('a failed start throws (after trying the others) so the caller can mark its row failed', async () => {
    process.env.JOBS_CF_GROUPS = '6,3';
    create.mockRejectedValueOnce(new Error('workflows down'));
    await expect(dispatchEvents(ev, async () => ({ ids: [] }))).rejects.toThrow('workflows down');
    expect(qsend).toHaveBeenCalledTimes(1); // the queue subscriber was still tried
    expect(create).toHaveBeenCalledTimes(2); // and the other workflow
  });

  it('a failing Inngest send still throws', async () => {
    await expect(
      dispatchEvents(ev, async () => {
        throw new Error('inngest 500');
      })
    ).rejects.toThrow('inngest 500');
  });

  it('idempotency: the instance id comes from the key, a duplicate create is not an error', async () => {
    process.env.JOBS_CF_GROUPS = '5';
    const e = { name: 'webhook/delivery.requested', data: { deliveryId: 'd-1', storeId: 's1' } };
    await dispatchEvents(e, async () => ({ ids: [] }));
    await dispatchEvents(e, async () => ({ ids: [] }));
    const ids = create.mock.calls.map(c => c[0].id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe('webhook-deliver--d-1');
    create.mockRejectedValueOnce(new Error('instance.already_exists'));
    await expect(dispatchEvents(e, async () => ({ ids: [] }))).resolves.toBeTruthy();
  });

  it('without an idempotency key every event is its own instance', async () => {
    process.env.JOBS_CF_GROUPS = '6';
    await dispatchEvents(ev, async () => ({ ids: [] }));
    await dispatchEvents(ev, async () => ({ ids: [] }));
    expect(create.mock.calls[0]![0].id).not.toBe(create.mock.calls[1]![0].id);
  });

  it('debounce: the event registers with the gate and the token travels with the run', async () => {
    process.env.JOBS_CF_GROUPS = '5';
    await dispatchEvents({ name: 'product.upserted', data: { storeId: 's1' } }, async () => ({
      ids: [],
    }));
    expect(touch).toHaveBeenCalledWith(120_000);
    expect(create.mock.calls[0]![0].params).toMatchObject({ debounceToken: 'tok-1' });
  });

  it('instance ids stay within the Workflows limit', async () => {
    process.env.JOBS_CF_GROUPS = '5';
    await dispatchEvents(
      { name: 'webhook/delivery.requested', data: { deliveryId: 'x'.repeat(300) } },
      async () => ({ ids: [] })
    );
    const id = create.mock.calls[0]![0].id;
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('attachJobs', () => {
  it('wraps send, records functions, and makes a moved function a no-op on Inngest', async () => {
    const created: Array<{ options: { id: string }; handler: (c: unknown) => Promise<unknown> }> =
      [];
    const client = {
      send: vi.fn(async () => ({ ids: [] })),
      createFunction: (options: { id: string }, handler: (c: unknown) => Promise<unknown>) => {
        created.push({ options, handler });
        return { id: options.id };
      },
    };
    attachJobs(client);
    const real = vi.fn(async () => 'ran');
    client.createFunction(
      { id: 'heartbeat', triggers: [{ cron: '0 * * * *' }] } as never,
      real as never
    );

    // On Inngest while the flag is off: the real handler runs.
    expect(await created[0]!.handler({ step: { run: vi.fn() } })).toBe('ran');
    // Moved: the Inngest copy does nothing.
    process.env.JOBS_CF_GROUPS = '1';
    real.mockClear();
    expect(await created[0]!.handler({ step: { run: vi.fn() } })).toEqual({
      skipped: 'runs-on-cloudflare',
    });
    expect(real).not.toHaveBeenCalled();
  });

  it('step.sendEvent inside a function still on Inngest goes through the dispatcher', async () => {
    const created: Array<(c: unknown) => Promise<unknown>> = [];
    const client = {
      send: vi.fn(async () => ({ ids: [] })),
      createFunction: (_o: unknown, handler: (c: unknown) => Promise<unknown>) => {
        created.push(handler);
        return {};
      },
    };
    attachJobs(client);
    process.env.JOBS_CF_GROUPS = '6';
    let seenStep: { sendEvent: (id: string, p: unknown) => Promise<unknown> } | undefined;
    client.createFunction(
      { id: 'stock-low-stock-alert-cron' } as never,
      (async (c: { step: typeof seenStep }) => {
        seenStep = c.step;
      }) as never
    );
    const run = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    await created[0]!({ step: { run } });
    await seenStep!.sendEvent('go', ev);
    expect(create).toHaveBeenCalledTimes(1); // the order/created subscriber on a moved group
  });
});
