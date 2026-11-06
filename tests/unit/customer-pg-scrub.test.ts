// Opus review of 7d03ec0cd, finding 2: erasing a DO-served customer also scrubs the stale Postgres copy; a failure is queued + P1.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  updates: [] as unknown[],
  definers: [] as string[],
  rows: { exists: true },
}));
vi.mock('@ebda/database', () => ({
  Prisma: { DbNull: 'DbNull' },
  prisma: {
    user: {
      findFirst: async () => (h.rows.exists ? { id: 'u1' } : null),
      update: async (a: unknown) => void h.updates.push(a),
    },
  },
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/definer', () => ({
  deleteUserTokens: async (id: string) => void h.definers.push(`tokens:${id}`),
  deleteUserPasskeys: async (id: string) => void h.definers.push(`passkeys:${id}`),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
const rt = vi.hoisted(() => ({ isWorkers: false, hyperdrive: false }));
vi.mock('@api/lib/runtime', () => ({
  get isWorkers() {
    return rt.isWorkers;
  },
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => (rt.isWorkers ? (rt.hyperdrive ? { HYPERDRIVE: {} } : {}) : undefined),
}));

import { isPgCopyScrub, scrubOrEnqueue, scrubPgCustomerCopy } from '@api/lib/customer-pg-scrub';

describe('scrubPgCustomerCopy', () => {
  it('anonymises the row, clears credentials and deletes tokens + passkeys', async () => {
    h.updates.length = 0;
    h.definers.length = 0;
    h.rows.exists = true;
    expect(await scrubPgCustomerCopy('u1', 's1')).toEqual({ scrubbed: true });
    const data = (h.updates[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      email: 'erased-u1@anonymized.local',
      firstName: 'Erased',
      phone: null,
      mfaSecret: null,
      mfaEnabled: false,
      status: 'inactive',
    });
    expect(String(data.passwordHash)).toMatch(/^[0-9a-f]{64}$/); // a random value, not the old hash
    expect(h.definers).toEqual(['tokens:u1', 'passkeys:u1']);
  });
  it('is idempotent: a customer with no Postgres row is a no-op', async () => {
    h.updates.length = 0;
    h.rows.exists = false;
    expect(await scrubPgCustomerCopy('u1', 's1')).toEqual({ scrubbed: false });
    expect(h.updates).toHaveLength(0);
  });
});

describe('scrubPgCustomerCopy on a Worker without Postgres (2026-11-06 POSTGRES_REMOVED P1)', () => {
  it('skips before any Prisma call, so no P1 and no retry loop', async () => {
    rt.isWorkers = true;
    rt.hyperdrive = false;
    h.updates.length = 0;
    h.rows.exists = true;
    try {
      expect(await scrubPgCustomerCopy('u1', 's1')).toEqual({
        scrubbed: false,
        skipped: 'postgres-removed',
      });
      expect(h.updates).toHaveLength(0);
      const enqueue = vi.fn();
      const alert = vi.fn();
      expect(await scrubOrEnqueue('u1', 's1', { enqueue, alert })).toEqual({
        scrubbed: false,
        enqueued: false,
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      rt.isWorkers = false;
    }
  });
  it('a Worker WITH a Hyperdrive binding still scrubs', async () => {
    rt.isWorkers = true;
    rt.hyperdrive = true;
    h.rows.exists = true;
    try {
      expect(await scrubPgCustomerCopy('u1', 's1')).toEqual({ scrubbed: true });
    } finally {
      rt.isWorkers = false;
      rt.hyperdrive = false;
    }
  });
});

describe('scrubOrEnqueue', () => {
  it('success: nothing queued, no alert', async () => {
    const enqueue = vi.fn();
    const alert = vi.fn();
    const r = await scrubOrEnqueue('u1', 's1', {
      scrub: async () => ({ scrubbed: true }),
      enqueue,
      alert,
    });
    expect(r).toEqual({ scrubbed: true, enqueued: false });
    expect(enqueue).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
  it('Postgres unreachable: queued for retry AND a P1 alert; never throws', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const alert = vi.fn().mockResolvedValue(undefined);
    const r = await scrubOrEnqueue('u1', 's1', {
      scrub: async () => {
        throw new Error('pg down');
      },
      enqueue,
      alert,
    });
    expect(r).toEqual({ scrubbed: false, enqueued: true });
    expect(enqueue).toHaveBeenCalledWith({ kind: 'pg-copy-scrub', userId: 'u1', storeId: 's1' });
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it('queue also down: still alerts, says so', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const r = await scrubOrEnqueue('u1', 's1', {
      scrub: async () => {
        throw new Error('x');
      },
      enqueue: async () => {
        throw new Error('q');
      },
      alert,
    });
    expect(r).toEqual({ scrubbed: false, enqueued: false });
    expect(alert.mock.calls[0][0].body).toMatch(/NO retry/);
  });
  it('message guard', () => {
    expect(isPgCopyScrub({ kind: 'pg-copy-scrub', userId: 'u', storeId: 's' })).toBe(true);
    expect(isPgCopyScrub({ kind: 'pg-copy-scrub', userId: 'u' })).toBe(false);
    expect(isPgCopyScrub(null)).toBe(false);
  });
});
