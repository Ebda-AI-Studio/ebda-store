/**
 * Issue 2057: assertStoreOwnsInTenantScope must reuse an AMBIENT tenant
 * transaction (the HTTP routes and barcode reconcile already wrap the service
 * call in runInTenantContext) and open its own only when there is none
 * (Inngest callers). A nested runInTenantContext takes a second pool
 * connection while the outer one is held and reads a different snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let ambient = false;
const order: string[] = [];

const mockRunInTenantContext = vi.fn(async (_s: string, fn: () => Promise<unknown>) => {
  order.push('runInTenantContext');
  return fn();
});

vi.mock('@ebda/database', () => ({
  prisma: {
    product: {
      findMany: vi.fn(async () => {
        order.push('product.findMany');
        return [{ id: 'p-1' }];
      }),
    },
  },
  hasTenantContext: () => ambient,
  runInTenantContext: (...a: unknown[]) =>
    mockRunInTenantContext(...(a as [string, () => Promise<unknown>])),
}));

import { assertStoreOwnsInTenantScope } from '@api/services/accounting/assert-store-owns';

beforeEach(() => {
  order.length = 0;
  mockRunInTenantContext.mockClear();
});

describe('assertStoreOwnsInTenantScope', () => {
  it('ambient context: runs the guard on it, opening NO nested transaction', async () => {
    ambient = true;
    await assertStoreOwnsInTenantScope('store-1', { productIds: ['p-1'] });
    expect(mockRunInTenantContext).not.toHaveBeenCalled();
    expect(order).toEqual(['product.findMany']);
  });

  it('no ambient context: opens a tenant-scoped transaction for the guard', async () => {
    ambient = false;
    await assertStoreOwnsInTenantScope('store-1', { productIds: ['p-1'] });
    expect(mockRunInTenantContext).toHaveBeenCalledWith('store-1', expect.any(Function));
    expect(order).toEqual(['runInTenantContext', 'product.findMany']);
  });

  it('still 404s a foreign id on the ambient path', async () => {
    ambient = true;
    await expect(
      assertStoreOwnsInTenantScope('store-1', { productIds: ['p-1', 'p-foreign'] })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
