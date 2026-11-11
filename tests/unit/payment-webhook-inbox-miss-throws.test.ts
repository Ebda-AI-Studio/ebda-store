/**
 * NEON-ZERO-1 N-10b: the payment webhook consumer THROWS on an inbox miss instead of returning.
 * During a cutover the inbox row can be mid-move; a silent `return` there would drop a payment
 * notification, while a throw makes Inngest retry the step and then dead-letter it.
 *
 * Behaviour, not source text: the REAL job handler runs with a fake `step` (runs its callback inline)
 * and an inbox that has no such row. (Split out of platform-n10b-d1.test.ts, whose file-wide mocks
 * must stay real for the D1 router tests.)
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@api/lib/definer', () => ({ webhookInbox: { get: h.get, update: h.update } }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(),
    createFunction: (o: unknown, f: unknown) => ({ options: o, handler: f }),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));

import { paymentWebhookProcess } from '@api/lib/inngest/functions/payment-webhook-process';

const run = (data: Record<string, unknown>) =>
  (paymentWebhookProcess as unknown as { handler: (c: unknown) => Promise<unknown> }).handler({
    event: { name: 'payment/webhook.received', data },
    step: { run: async (_name: string, fn: () => Promise<unknown>) => fn() },
  });

describe('payment-webhook-process: an inbox miss', () => {
  it('throws (retry, then dead-letter) and never returns quietly', async () => {
    h.get.mockResolvedValue(null);
    await expect(run({ webhookEventId: 'w1', idempotencyKey: 'k1' })).rejects.toThrow(
      /webhook inbox row w1 not found/
    );
    expect(h.get).toHaveBeenCalledWith('w1');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('control: an empty test payload (no webhookEventId) is the only quiet return, and reads nothing', async () => {
    h.get.mockClear();
    await expect(run({})).resolves.toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
  });
});
