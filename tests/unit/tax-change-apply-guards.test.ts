/**
 * applyApprovedTaxChange refuses a change that no longer describes the registration (Opus security review of #785):
 * - another store is already VERIFIED under the requested number (a pending holder is only a queue flag);
 * - the profile was revoked / re-verified / re-reviewed since the request was made (reviewedAt moved), or the row predates the guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  profiles: new Map<
    string,
    { id: string; status: string; taxRegistrationNumber: string | null; reviewedAt: Date | null }
  >(),
  updateMany: vi.fn(),
  docCreate: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withUser: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/services/storage.service', () => ({ StorageService: {} }));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: vi.fn() }));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/platform/directory-d1', () => ({
  listDirectoryStores: async () => [...m.profiles.keys()].map(id => ({ id, name: id, slug: id })),
}));
vi.mock('@api/lib/platform-scope', () => ({
  platformHubOnD1: async () => true,
  withPlatformUser: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/definer', () => ({ taxProfilesForReview: async () => [] }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async (storeId: string) => ({
    storeTaxProfile: { findUnique: async () => m.profiles.get(storeId) ?? null },
  }),
  storeWriter: async () => ({
    storeTaxProfile: { updateMany: m.updateMany },
    storeTaxDocument: { create: m.docCreate },
  }),
  storeRepo: vi.fn(),
  storeUpdate: vi.fn(),
}));

const REVIEWED = new Date('2026-11-01T00:00:00Z');
const change = (over: Record<string, unknown> = {}) => ({
  taxRegistrationNumber: '123456789',
  legalName: 'x',
  kind: 'tax_card' as const,
  storageKey: 'k',
  fileName: 'f.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
  requestedBy: 'u',
  profileReviewedAt: REVIEWED.toISOString(),
  ...over,
});
const actor = { userId: 'admin-1' };

beforeEach(() => {
  m.profiles.clear();
  m.updateMany.mockReset().mockResolvedValue({ count: 1 });
  m.docCreate.mockReset().mockResolvedValue({});
  m.profiles.set(STORE, {
    id: 'p1',
    status: 'verified',
    taxRegistrationNumber: '987654321',
    reviewedAt: REVIEWED,
  });
});

describe('applyApprovedTaxChange guards', () => {
  it('applies when nothing moved since the request', async () => {
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await applyApprovedTaxChange(STORE, change(), actor);
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.docCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses when ANOTHER store is verified under that number, and writes nothing', async () => {
    m.profiles.set(OTHER, {
      id: 'p2',
      status: 'verified',
      taxRegistrationNumber: '123456789',
      reviewedAt: null,
    });
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await expect(applyApprovedTaxChange(STORE, change(), actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRN_IN_USE_BY_OTHER_STORE',
    });
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.docCreate).not.toHaveBeenCalled();
  });

  it('a PENDING holder elsewhere is only a flag: the change still applies', async () => {
    m.profiles.set(OTHER, {
      id: 'p2',
      status: 'pending',
      taxRegistrationNumber: '123456789',
      reviewedAt: null,
    });
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await applyApprovedTaxChange(STORE, change(), actor);
    expect(m.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses (409) when the profile was re-reviewed since the request (revoke + re-verify)', async () => {
    m.profiles.set(STORE, {
      id: 'p1',
      status: 'verified',
      taxRegistrationNumber: '987654321',
      reviewedAt: new Date('2026-11-10T00:00:00Z'),
    });
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await expect(applyApprovedTaxChange(STORE, change(), actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TAX_CHANGE_STALE',
    });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a row that does not record the reviewedAt it was made against (fail closed)', async () => {
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await expect(
      applyApprovedTaxChange(STORE, change({ profileReviewedAt: undefined }), actor)
    ).rejects.toMatchObject({ code: 'TAX_CHANGE_STALE' });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('a request made against a never-reviewed profile (null) matches a still-never-reviewed one only', async () => {
    m.profiles.set(STORE, {
      id: 'p1',
      status: 'verified',
      taxRegistrationNumber: '987654321',
      reviewedAt: null,
    });
    const { applyApprovedTaxChange } = await import('@api/services/tax-profile.service');
    await applyApprovedTaxChange(STORE, change({ profileReviewedAt: null }), actor);
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    m.updateMany.mockClear();
    await expect(applyApprovedTaxChange(STORE, change(), actor)).rejects.toMatchObject({
      code: 'TAX_CHANGE_STALE',
    });
  });
});
