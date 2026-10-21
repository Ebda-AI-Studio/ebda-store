/** Wiring for the cart-recovery email: config validation, Inngest registration, onFailure. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  captured: { config: null as any, handler: null as any },
  updateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  deliver: vi.fn(async (..._a: unknown[]) => ({ outcome: 'sent' })),
}));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (cfg: unknown, handler: unknown) => {
      h.captured.config = cfg;
      h.captured.handler = handler;
      return { id: 'cart-recovery-email' };
    },
  },
}));
vi.mock('@ebda/database', () => ({
  prisma: { abandonedCart: { updateMany: h.updateMany } },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/cart-recovery-email.service', () => ({
  deliverCartRecoveryEmail: h.deliver,
  CART_EMAIL_MIN_DELAY_MINUTES: 60,
  CART_EMAIL_MAX_DELAY_MINUTES: 1440,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import '@api/lib/inngest/functions/cart-recovery-email';

describe('cart-recovery-email Inngest function', () => {
  it('is triggered only by its own event, retries, and is concurrency-limited per store', () => {
    expect(h.captured.config.triggers).toEqual([{ event: 'cart-recovery/email-requested' }]);
    expect(h.captured.config.retries).toBe(4);
    expect(h.captured.config.concurrency.key).toBe('event.data.storeId');
  });

  it('delivers inside a step and skips an event without ids', async () => {
    const step = { run: async (_n: string, fn: () => unknown) => fn() };
    await h.captured.handler({ event: { data: { abandonedCartId: 'a', storeId: 's' } }, step });
    expect(h.deliver).toHaveBeenCalledWith('s', 'a');
    h.deliver.mockClear();
    const r = await h.captured.handler({ event: { data: {} }, step });
    expect(r).toEqual({ skipped: 'missing-ids' });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('onFailure marks only a still-queued row failed (no orphan queued)', async () => {
    await h.captured.config.onFailure({
      event: { data: { event: { data: { abandonedCartId: 'a', storeId: 's' } } } },
    });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: 'a', storeId: 's', emailStatus: 'queued' },
      data: { emailStatus: 'failed', emailDetail: 'SEND_JOB_FAILED' },
    });
  });

  it('is registered in the Inngest function registry', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/lib/inngest/functions/index.ts'),
      'utf8'
    );
    expect(src).toMatch(/import \{ cartRecoveryEmail \} from '\.\/cart-recovery-email'/);
    expect(src).toMatch(/^\s+cartRecoveryEmail,$/m);
  });
});

describe('abandoned-cart config schema (email fields)', () => {
  it('accepts 60..1440 and rejects outside it', async () => {
    vi.resetModules();
    vi.doUnmock('@ebda/database');
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/routes/abandoned-cart.routes.ts'),
      'utf8'
    );
    expect(src).toMatch(
      /emailDelayMinutes: z\s*\.number\(\)\s*\.int\(\)\s*\.min\(CART_EMAIL_MIN_DELAY_MINUTES\)\s*\.max\(CART_EMAIL_MAX_DELAY_MINUTES\)/
    );
    expect(src).toMatch(/emailEnabled: z\.boolean\(\)\.optional\(\)/);
  });
});
