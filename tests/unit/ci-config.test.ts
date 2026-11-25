/** CI capture wiring: the port, the boot assert, the Worker config and the retention that must match. */
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertCiCaptureConfig,
  CI_EVENTS_DLQ,
  CI_EVENTS_QUEUE,
  CI_RAW_RETENTION_DAYS,
} from '../../apps/api/src/lib/ci/config';
import { queueOutcomesPort, setCommerceOutcomesPort } from '../../apps/api/src/lib/ci/port';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { emitCiOutcomesFor } from '../../apps/api/src/lib/inngest/functions/ci-outcomes';
import {
  CI_SHIPMENT_BOOKED_EVENT,
  CI_SHIPMENT_TRACKED_EVENT,
} from '../../apps/api/src/lib/ci/events';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const cfg = (() => {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', read('apps/api/wrangler.jsonc'));
  return parsed.config as Record<string, any>;
})();

const SECRET = 's'.repeat(40);
const input = {
  type: 'shipment.picked_up' as const,
  seed: 'x',
  occurredAt: new Date(),
  orderId: '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa',
  storeId: '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10',
  buyerKey: null,
  xstore: false,
  data: { carrier: 'bosta', hoursSinceCreated: 2 },
};

describe('queueOutcomesPort', () => {
  it('sends one validated envelope per input to the queue', async () => {
    const send = vi.fn();
    await queueOutcomesPort(() => ({ send }) as never).emit([input]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      v: 1,
      type: 'shipment.picked_up',
      product: 'store',
      keyVersion: 1,
    });
    expect(send.mock.calls[0]![1]).toEqual({ contentType: 'json' });
  });

  it('is a no-op outside a Worker (Node dev, unit tests) but FAILS LOUD inside one with no queue bound', async () => {
    clearCfBindings();
    await expect(queueOutcomesPort(() => undefined).emit([input])).resolves.toBeUndefined();
    setCfBindings({});
    await expect(queueOutcomesPort(() => undefined).emit([input])).rejects.toThrow(
      /CI_EVENTS_QUEUE/
    );
    clearCfBindings();
  });

  it('rejects an invalid input instead of enqueueing it', async () => {
    const send = vi.fn();
    await expect(
      queueOutcomesPort(() => ({ send }) as never).emit([
        {
          ...input,
          data: { carrier: 'bosta', hoursSinceCreated: 2, phone: '+201001234567' },
        } as never,
      ])
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('assertCiCaptureConfig', () => {
  const base = {};
  it('does nothing without the queue binding, and demands bucket, dataset and secret with it', () => {
    vi.stubEnv('SUITE_BUYER_KEY_SECRET', SECRET);
    expect(() => assertCiCaptureConfig(base)).not.toThrow();
    const q = { CI_EVENTS_QUEUE: { send: vi.fn() } };
    expect(() => assertCiCaptureConfig({ ...base, ...q })).toThrow(/CI_BUCKET/);
    expect(() => assertCiCaptureConfig({ ...base, ...q, CI_BUCKET: {} as never })).toThrow(
      /CI_OUTCOMES/
    );
    expect(() =>
      assertCiCaptureConfig({ ...base, ...q, CI_BUCKET: {} as never, CI_OUTCOMES: {} as never })
    ).not.toThrow();
    vi.stubEnv('SUITE_BUYER_KEY_SECRET', '');
    expect(() =>
      assertCiCaptureConfig({ ...base, ...q, CI_BUCKET: {} as never, CI_OUTCOMES: {} as never })
    ).toThrow(/SUITE_BUYER_KEY_SECRET/);
    vi.unstubAllEnvs();
  });
});

describe('emitCiOutcomesFor routing', () => {
  it('routes every source event to its planner and hands the result to the port', async () => {
    const emit = vi.fn();
    const source = {
      order: vi.fn(async () => null),
      shipment: vi.fn(async () => null),
    };
    const ctx = { source: source as never, secret: SECRET };
    await expect(
      emitCiOutcomesFor(
        { name: 'order/created', data: { storeId: 's', orderId: 'o' } },
        { ctx, port: { emit } }
      )
    ).rejects.toThrow(/not visible/);
    await expect(
      emitCiOutcomesFor(
        { name: 'order/status-changed', data: { storeId: 's', orderId: 'o', status: 'cancelled' } },
        { ctx, port: { emit } }
      )
    ).rejects.toThrow(/not visible/);
    await expect(
      emitCiOutcomesFor(
        { name: CI_SHIPMENT_BOOKED_EVENT, data: { storeId: 's', shipmentId: 'x' } },
        { ctx, port: { emit } }
      )
    ).rejects.toThrow(/not visible/);
    await expect(
      emitCiOutcomesFor(
        {
          name: CI_SHIPMENT_TRACKED_EVENT,
          data: {
            storeId: 's',
            shipmentId: 'x',
            ci: [{ kind: 'picked_up', at: new Date().toISOString() }],
          },
        },
        { ctx, port: { emit } }
      )
    ).rejects.toThrow(/not visible/);
    expect(
      await emitCiOutcomesFor({ name: 'something/else', data: {} }, { ctx, port: { emit } })
    ).toBe(0);
    expect(emit).toHaveBeenLastCalledWith([]);
  });

  it('does nothing in Node (no Worker bindings, no injected deps): no secret needed in local dev', async () => {
    clearCfBindings();
    setCommerceOutcomesPort(undefined);
    expect(
      await emitCiOutcomesFor({ name: 'order/created', data: { storeId: 's', orderId: 'o' } })
    ).toBe(0);
  });
});

describe('wrangler.jsonc and the Worker entry', () => {
  it('binds the capture queue, its DLQ consumer, the private bucket and the dataset', () => {
    const q = cfg.queues;
    expect(q.producers).toContainEqual({ binding: 'CI_EVENTS_QUEUE', queue: CI_EVENTS_QUEUE });
    const main = q.consumers.find((c: any) => c.queue === CI_EVENTS_QUEUE);
    expect(main).toMatchObject({ dead_letter_queue: CI_EVENTS_DLQ });
    expect(main.max_batch_size).toBeLessThanOrEqual(25); // Analytics Engine writes per invocation
    expect(main.max_retries).toBeGreaterThanOrEqual(3);
    expect(q.consumers.some((c: any) => c.queue === CI_EVENTS_DLQ)).toBe(true);
    expect(cfg.r2_buckets).toContainEqual({ binding: 'CI_BUCKET', bucket_name: 'ebda-ci' });
    // CI_OUTCOMES stays commerce-only; REQUEST_BUDGET is the separate per-route counter dataset (NEON-ZERO 9.2).
    expect(cfg.analytics_engine_datasets).toEqual([
      { binding: 'CI_OUTCOMES', dataset: 'ebda_commerce_outcomes' },
      { binding: 'REQUEST_BUDGET', dataset: 'ebda_request_budget' },
    ]);
  });

  it('the Worker routes both CI queues to the sink and asserts the config at boot', () => {
    const w = read('apps/api/src/worker.ts');
    expect(w).toMatch(
      /CI_EVENTS_QUEUE \|\| batch\.queue === CI_EVENTS_DLQ[\s\S]{0,80}handleCiEventsBatch/
    );
    expect(w).toContain('assertCiCaptureConfig(env)');
  });

  it('retention: 24 months in code, in the lifecycle script, and on the right prefix', () => {
    expect(CI_RAW_RETENTION_DAYS).toBe(730);
    const sh = read('scripts/ops/ci-capture-setup.sh');
    expect(sh).toContain(`RETENTION_SECONDS=${CI_RAW_RETENTION_DAYS * 86400}`);
    for (const rule of [
      'expire-ci-raw-24m',
      'expire-ci-index-24m',
      'expire-ci-tombstone-30d',
      'expire-ci-dlq-14d',
    ])
      expect(sh).toContain(rule);
    expect(sh).toMatch(/"outcomes\/"[^\n]*63072000/);
    expect(sh).not.toMatch(/allow-public|r2\.dev/);
  });
});
