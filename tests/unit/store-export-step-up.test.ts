/**
 * Whole-store export (M2/m3 of the #772 re-review): the bundle carries customer PII, so it needs the single-use step-up token,
 * the owner is emailed on every export (on the identity service's address for the owner, never one a request supplied), and an
 * order's lines are capped so the row cap really bounds Worker memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/config', () => ({
  config: { encryptionKey: 'test-encryption-key-0123456789abcdef' },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => false, getClient: () => null },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const h = vi.hoisted(() => ({
  notify: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  findMany: vi.fn(async (_a: unknown) => [] as unknown[]),
}));
vi.mock('@api/services/store-deletion.wiring', () => ({
  productionDeletionDeps: () => ({
    loadStore: async (id: string) =>
      id === 'store-a'
        ? { id, name: 'Shop A', slug: 'shop-a', ownerId: 'owner-1', deletionRequest: null }
        : null,
    ownerEmail: async (u: string) => (u === 'owner-1' ? 'owner@identity.example' : null),
    notifyOwner: h.notify,
    audit: h.audit,
  }),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  withStoreDb: async (_id: string, fn: (db: unknown) => unknown) =>
    fn(new Proxy({}, { get: () => ({ findMany: h.findMany }), has: () => true })),
}));

beforeEach(() => {
  h.notify.mockClear();
  h.audit.mockClear();
  h.findMany.mockClear();
});

async function token(userId = 'owner-1') {
  const { exportPreview } = await import('@api/services/store-export.wiring');
  return (await exportPreview({ storeId: 'store-a', userId })).confirmToken;
}

describe('export step-up (M2)', () => {
  it('refuses without a valid token and reads no row', async () => {
    const { exportStoreBundle } = await import('@api/services/store-export.wiring');
    await expect(
      exportStoreBundle({ storeId: 'store-a', userId: 'owner-1', confirmToken: 'garbage.token' })
    ).rejects.toMatchObject({ code: 'CONFIRM_TOKEN_INVALID' });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it('a delete-flow token cannot be used for an export, and a non-owner cannot even get one', async () => {
    const { previewStoreDeletion } = await import('@api/services/store-deletion.service');
    const { productionDeletionDeps } = await import('@api/services/store-deletion.wiring');
    const { exportStoreBundle, exportPreview } = await import('@api/services/store-export.wiring');
    const deps = {
      ...productionDeletionDeps(),
      moneyInFlight: async () => null,
      hasBilledSubscription: async () => false,
      isBillingParentWithSiblings: async () => false,
      erasureBlocked: async () => false,
    };
    const del = await previewStoreDeletion(
      { storeId: 'store-a', userId: 'owner-1' },
      deps as never
    );
    if (!del.ok) throw new Error('preview refused');
    await expect(
      exportStoreBundle({ storeId: 'store-a', userId: 'owner-1', confirmToken: del.confirmToken })
    ).rejects.toMatchObject({ code: 'CONFIRM_TOKEN_INVALID' });
    await expect(exportPreview({ storeId: 'store-a', userId: 'staff-9' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('a valid token works once (replay refused), audits, and emails the OWNER on the identity address', async () => {
    const { exportStoreBundle } = await import('@api/services/store-export.wiring');
    const t = await token();
    const r = await exportStoreBundle({ storeId: 'store-a', userId: 'owner-1', confirmToken: t });
    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STORE_DATA_EXPORTED' })
    );
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      'exported',
      expect.objectContaining({ to: 'owner@identity.example' })
    );
    await expect(
      exportStoreBundle({ storeId: 'store-a', userId: 'owner-1', confirmToken: t })
    ).rejects.toMatchObject({ code: 'CONFIRM_TOKEN_INVALID' });
  });
});

describe('export order lines are capped (m3)', () => {
  it('asks for at most EXPORT_ITEMS_PER_ORDER lines per order', async () => {
    const { exportStoreBundle } = await import('@api/services/store-export.wiring');
    const { EXPORT_ITEMS_PER_ORDER } = await import('@api/services/store-export.service');
    await exportStoreBundle({
      storeId: 'store-a',
      userId: 'owner-1',
      confirmToken: await token(),
    });
    const orderCall = h.findMany.mock.calls
      .map(c => c[0] as { include?: { items?: { take?: number } } })
      .find(a => a.include?.items);
    expect(orderCall?.include?.items?.take).toBe(EXPORT_ITEMS_PER_ORDER);
    expect(EXPORT_ITEMS_PER_ORDER).toBeGreaterThan(0);
  });
});
