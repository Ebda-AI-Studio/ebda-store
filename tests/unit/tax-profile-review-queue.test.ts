/**
 * The super-admin VAT review queue on the platform hub (ported from tests/integration/vat-gate.test.ts, "the review queue ...
 * lists the pending profile with its duplicate-TRN signal"). The directory is the platform D1 `stores` list and each store's
 * profile is read from that store's own Durable Object. Who may open the queue (super_admin only) is the route gate, proven by
 * tests/unit/vat-gate-routes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type P = {
  status: string;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  submittedAt: Date | null;
  docs: number;
};
const h = vi.hoisted(() => ({
  stores: [] as Array<{ id: string; name: string; slug: string }>,
  profiles: new Map<string, unknown>(),
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return { ...real, prisma: {}, withStore: async (_s: string, fn: () => unknown) => fn() };
});
vi.mock('@api/lib/platform-scope', () => ({ platformHubOnD1: async () => true }));
vi.mock('@api/services/platform/directory-d1', () => ({
  listDirectoryStores: async () => h.stores,
}));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeDb: async (id: string) => ({
    storeTaxProfile: {
      findUnique: async () => {
        const p = h.profiles.get(id) as P | undefined;
        return p
          ? { id: `p-${id}`, reviewedAt: null, verifiedAt: null, rejectionReason: null, ...p }
          : null;
      },
    },
    storeTaxDocument: { count: async () => (h.profiles.get(id) as P | undefined)?.docs ?? 0 },
  }),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/services/storage.service', () => ({ StorageService: {} }));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: async () => undefined }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { listProfilesForReview } from '@api/services/tax-profile.service';

const put = (id: string, status: string, trn: string | null, at: number | null, docs = 1) => {
  h.stores.push({ id, name: `Store ${id}`, slug: id });
  h.profiles.set(id, {
    status,
    taxRegistrationNumber: trn,
    legalName: trn ? 'Acme LLC' : null,
    submittedAt: at === null ? null : new Date(at),
    docs,
  } satisfies P);
};

beforeEach(() => {
  h.stores.length = 0;
  h.profiles.clear();
});

describe('listProfilesForReview on the platform hub', () => {
  it('lists the pending profiles oldest first with their document count, and leaves out every other status', async () => {
    put('late', 'pending', '111111111', 3000, 2);
    put('early', 'pending', '222222222', 1000);
    put('done', 'verified', '333333333', 500);
    put('blank', 'none', null, null, 0);
    const rows = await listProfilesForReview('pending');
    expect(rows.map(r => r.storeId)).toEqual(['early', 'late']);
    expect(rows[1]).toMatchObject({
      status: 'pending',
      taxRegistrationNumber: '111111111',
      documentCount: 2,
      storeName: 'Store late',
    });
  });

  it('null lists every profile that is not "none"', async () => {
    put('a', 'pending', '111111111', 1);
    put('b', 'revoked', '222222222', 2);
    put('c', 'none', null, null, 0);
    expect((await listProfilesForReview(null)).map(r => r.storeId)).toEqual(['a', 'b']);
  });

  it('flags a TRN also held by another pending or verified store, never by itself or a rejected one', async () => {
    put('a', 'pending', '444444444', 1);
    put('b', 'pending', '444444444', 2);
    put('c', 'verified', '444444444', 3);
    put('d', 'rejected', '444444444', 4);
    put('solo', 'pending', '555555555', 5);
    const by = Object.fromEntries(
      (await listProfilesForReview('pending')).map(r => [r.storeId, r])
    );
    expect(by.a.duplicateTrnStores).toBe(2); // b and c; the rejected d does not count
    expect(by.b.duplicateTrnStores).toBe(2);
    expect(by.solo.duplicateTrnStores).toBe(0);
  });
});
