/** The fan-out loop: bounded wait-and-retry while the source row is not visible, then give up quietly. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  build: vi.fn(),
  fanout: vi.fn(),
  count: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
  prisma: { webhookEndpoint: { count: h.count } },
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));
vi.mock('../../apps/api/src/services/webhook-events', async () => {
  class SourceNotReadyError extends Error {}
  return { buildFanoutEvents: h.build, SourceNotReadyError };
});
vi.mock('../../apps/api/src/services/webhook.service', () => ({
  fanoutWebhookEvent: h.fanout,
  delayBeforeAttempt: () => 0,
  runDeliveryAttempt: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { createFunction: () => ({}), send: vi.fn() },
}));
vi.mock('../../apps/api/src/services/email.service', () => ({ EmailService: {} }));
vi.mock('../../apps/api/src/services/socket.service', () => ({ socketService: {} }));
vi.mock('../../apps/api/src/config', () => ({ config: { adminUrl: 'http://admin' } }));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runWebhookFanout } from '../../apps/api/src/lib/inngest/functions/webhook-delivery';
import { SourceNotReadyError } from '../../apps/api/src/services/webhook-events';

const makeStep = () => ({
  run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
  sleep: vi.fn(async () => undefined),
  sendEvent: vi.fn(async () => undefined),
});
const ev = { name: 'order/created', data: { storeId: 's1', orderId: 'o1' }, id: 'e1' };

beforeEach(() => {
  Object.values(h).forEach(f => f.mockReset());
  h.count.mockResolvedValue(1);
  h.fanout.mockResolvedValue(['d1']);
});

describe('runWebhookFanout', () => {
  it('waits and retries while the order is not visible, then dispatches', async () => {
    h.build
      .mockRejectedValueOnce(new SourceNotReadyError('x'))
      .mockRejectedValueOnce(new SourceNotReadyError('x'))
      .mockResolvedValue([{ type: 'order.created', dedupeKey: 'k', data: {} }]);
    const step = makeStep();
    const r = await runWebhookFanout(step as any, ev as any);
    expect(r).toEqual({ deliveries: 1 });
    expect(step.sleep).toHaveBeenCalledTimes(2);
    expect(step.sendEvent).toHaveBeenCalledTimes(1);
  });
  it('is bounded: gives up after the last wait and sends nothing', async () => {
    h.build.mockRejectedValue(new SourceNotReadyError('x'));
    const step = makeStep();
    const r = await runWebhookFanout(step as any, ev as any);
    expect(r).toMatchObject({ skipped: 'source_not_ready' });
    expect(step.sleep.mock.calls.length).toBeGreaterThan(0);
    expect(step.sleep.mock.calls.length).toBeLessThanOrEqual(6);
    expect(h.fanout).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });
  it('a real error (not "not ready") still fails the run', async () => {
    h.build.mockRejectedValue(new Error('db down'));
    await expect(runWebhookFanout(makeStep() as any, ev as any)).rejects.toThrow('db down');
  });
  it('no active endpoint: nothing is read or built', async () => {
    h.count.mockResolvedValue(0);
    const r = await runWebhookFanout(makeStep() as any, ev as any);
    expect(r).toEqual({ deliveries: 0 });
    expect(h.build).not.toHaveBeenCalled();
  });
});
