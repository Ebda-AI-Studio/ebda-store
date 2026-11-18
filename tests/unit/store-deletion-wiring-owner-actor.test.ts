/** C1 wiring: the production `deleteStore` dep must hand the OWNER request to StoreService.delete (never the bare owner id). */
import { describe, it, expect, vi } from 'vitest';

const del = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@api/services/store.service', () => ({ StoreService: { delete: del } }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/repo-factory', () => ({ storeWritesToDo: async () => false }));
vi.mock('@api/lib/store-create-do', () => ({ ownerStores: vi.fn() }));
vi.mock('@api/services/email.service', () => ({ EmailService: { sendPlatformRaw: vi.fn() } }));
vi.mock('@api/lib/identity-client', () => ({ getAccountState: vi.fn() }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/services/billing/billing-parent', () => ({ sortOwnerStores: (x: unknown) => x }));
vi.mock('@api/services/account-closure-guard', () => ({ BILLED_SUBSCRIPTION_STATUSES: [] }));
vi.mock('@api/services/store-closure.service', () => ({ moneyInFlight: vi.fn() }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@ebda/database', () => ({ withStore: vi.fn(), withUser: vi.fn() }));

describe('productionDeletionDeps.deleteStore', () => {
  it('runs the delete as an owner request carrying the request id', async () => {
    const { productionDeletionDeps } = await import('@api/services/store-deletion.wiring');
    await productionDeletionDeps().deleteStore('s1', 'owner-1', 'req-9');
    expect(del).toHaveBeenCalledWith('s1', 'owner-1', { ownerRequest: { requestId: 'req-9' } });
  });
});
