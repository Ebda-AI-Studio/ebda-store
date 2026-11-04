/**
 * G5: `inngest.send` routing. Every subscriber starts a Workflow or a queue message; a failed start
 * throws (so "enqueue failed -> mark the row failed" callers keep working); without the Worker
 * bindings (Node) nothing starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { dispatchEvents } from '@api/lib/jobs/dispatch';
import { jobRunsOnCf } from '@api/lib/jobs/flag';
import { inngest } from '@api/lib/inngest/client';

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
  clearCfBindings();
});

const ev = { name: 'order/created', data: { storeId: 's1', orderId: 'o1' } };

describe('flag', () => {
  it('runs on Cloudflare only with the bindings (Worker), never in Node, never for an unmapped job', () => {
    expect(jobRunsOnCf('order-created-fanout')).toBe(true);
    clearCfBindings();
    expect(jobRunsOnCf('order-created-fanout')).toBe(false);
    bind();
    expect(jobRunsOnCf('not-in-the-map')).toBe(false);
  });
});

describe('dispatchEvents', () => {
  it('starts every subscriber: Workflows and queue messages', async () => {
    await dispatchEvents(ev);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map(c => (c[0].params as { fn: string }).fn).sort()).toEqual([
      'accounting-post-order-journal',
      'order-created-fanout',
    ]);
    expect(qsend).toHaveBeenCalledTimes(1);
  });

  it('Node (no bindings): nothing starts and send resolves', async () => {
    clearCfBindings();
    await expect(inngest.send(ev)).resolves.toEqual({ ids: [] });
    expect(create).not.toHaveBeenCalled();
    expect(qsend).not.toHaveBeenCalled();
  });

  it('an event nobody subscribes to throws in the Worker (Ruling JOBS-ORPHAN-1), starting nothing', async () => {
    await expect(dispatchEvents({ name: 'unknown/event' })).rejects.toThrow(/would start nothing/);
    expect(create).not.toHaveBeenCalled();
    expect(qsend).not.toHaveBeenCalled();
  });

  it('a failed start throws (after trying the others) so the caller can mark its row failed', async () => {
    create.mockRejectedValueOnce(new Error('workflows down'));
    await expect(dispatchEvents(ev)).rejects.toThrow('workflows down');
    expect(qsend).toHaveBeenCalledTimes(1); // the queue subscriber was still tried
    expect(create).toHaveBeenCalledTimes(2); // and the other workflow
  });

  it('idempotency: the instance id comes from the key, a duplicate create is not an error', async () => {
    const e = { name: 'webhook/delivery.requested', data: { deliveryId: 'd-1', storeId: 's1' } };
    await dispatchEvents(e);
    await dispatchEvents(e);
    const ids = create.mock.calls.map(c => c[0].id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe('webhook-deliver--d-1');
    create.mockRejectedValueOnce(new Error('instance.already_exists'));
    await expect(dispatchEvents(e)).resolves.toBeTruthy();
  });

  it('without an idempotency key every event is its own instance', async () => {
    await dispatchEvents(ev);
    await dispatchEvents(ev);
    const ids = create.mock.calls.map(c => c[0].id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('debounce: the event registers with the gate and the token travels with the run', async () => {
    await dispatchEvents({ name: 'product.upserted', data: { storeId: 's1' } });
    expect(touch).toHaveBeenCalledWith(120_000);
    expect(create.mock.calls[0]![0].params).toMatchObject({ debounceToken: 'tok-1' });
  });

  it('instance ids stay within the Workflows limit', async () => {
    await dispatchEvents({
      name: 'webhook/delivery.requested',
      data: { deliveryId: 'x'.repeat(300) },
    });
    const id = create.mock.calls[0]![0].id;
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the in-repo client', () => {
  it('createFunction registers the handler in the job registry', () => {
    const def = inngest.createFunction(
      { id: 'heartbeat', triggers: [{ cron: '0 * * * *' }] },
      async () => 'ran'
    );
    expect(def.id).toBe('heartbeat');
  });
});
