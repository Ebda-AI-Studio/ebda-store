/** `runAsMerchant` (plan 4 B5, SL-STORE-2): the gate chain the Merchant MCP and the assistant share, proven without a database. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  scoped: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: m.auditLog }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({ runInStoreTenantContext: m.scoped }));

import { runAsMerchant, MerchantForbidden } from '@api/mcp/run-as-merchant';

const base = {
  storeId: 's1',
  userId: 'u1',
  role: 'store_admin',
  actor: 'assistant' as const,
  tool: 'product_delete',
  permission: 'products:delete' as const,
  audit: { action: 'product.deleted', resourceType: 'product', resourceId: 'p1' },
  details: { n: 1 },
};

describe('runAsMerchant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.featureEnabled.mockResolvedValue(true);
    m.insertAuditLog.mockResolvedValue(undefined);
    m.auditLog.mockResolvedValue(undefined);
    m.scoped.mockImplementation(async (_s: string, fn: () => unknown) => fn());
  });

  it('staff cannot run products:delete', async () => {
    const fn = vi.fn();
    await expect(runAsMerchant({ ...base, role: 'staff' }, fn)).rejects.toBeInstanceOf(
      MerchantForbidden
    );
    expect(fn).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it('a super admin never acts through it', async () => {
    const fn = vi.fn();
    await expect(runAsMerchant({ ...base, role: 'super_admin' }, fn)).rejects.toThrow(/FORBIDDEN/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a feature the plan does not include refuses', async () => {
    m.featureEnabled.mockResolvedValue(false);
    const fn = vi.fn();
    await expect(runAsMerchant({ ...base, feature: 'coupons' as never }, fn)).rejects.toThrow(
      /feature/
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('audit intent failure refuses the write', async () => {
    m.insertAuditLog.mockRejectedValue(new Error('down'));
    const fn = vi.fn();
    await expect(runAsMerchant(base, fn)).rejects.toThrow(/UNAVAILABLE/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('audit actor reads "user X via assistant", intent first, completed after', async () => {
    const order: string[] = [];
    m.insertAuditLog.mockImplementation(async () => void order.push('intent'));
    m.auditLog.mockImplementation(async () => void order.push('completed'));
    const out = await runAsMerchant(base, async () => {
      order.push('fn');
      return 42;
    });
    expect(out).toBe(42);
    expect(order).toEqual(['intent', 'fn', 'completed']);
    const row = m.insertAuditLog.mock.calls[0]![0];
    expect(row).toMatchObject({ userId: 'u1', storeId: 's1', action: 'product.deleted' });
    expect(row.details).toMatchObject({
      actor: 'assistant',
      phase: 'intent',
      tool: 'product_delete',
    });
  });

  it('a failing change writes a failed row and rethrows', async () => {
    await expect(
      runAsMerchant(base, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(m.auditLog.mock.calls[0]![0].details).toMatchObject({ phase: 'failed', error: 'boom' });
  });

  it('runs inside the store tenant context as the acting user', async () => {
    await runAsMerchant(base, async () => 1);
    expect(m.scoped).toHaveBeenCalledWith('s1', expect.any(Function), 'u1');
  });
});
