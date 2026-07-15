import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerAddressService } from '@api/services/customer-address.service';

const mockPrisma = {
  customerAddress: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  customer: {
    findFirst: vi.fn(),
  },
};

const STORE_A = 'store-a';

describe('CustomerAddressService', () => {
  const svc = new CustomerAddressService(mockPrisma as any);
  beforeEach(() => vi.clearAllMocks());

  it('listForCustomer scopes the query by the customer relation storeId', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([
      { id: 'a1', label: 'Home', isDefault: true },
      { id: 'a2', label: 'Office', isDefault: false },
    ]);
    const addresses = await svc.listForCustomer('cust1', STORE_A);
    expect(mockPrisma.customerAddress.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust1', customer: { storeId: STORE_A } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    expect(addresses).toHaveLength(2);
  });

  it('listForCustomer returns nothing for a customer owned by another store (cross-tenant)', async () => {
    // The scoped where clause means Prisma itself returns [] for a
    // customerId that belongs to a different store — no separate
    // ownership check needed on read.
    mockPrisma.customerAddress.findMany.mockResolvedValue([]);
    const addresses = await svc.listForCustomer('cust-owned-by-store-b', STORE_A);
    expect(addresses).toEqual([]);
  });

  it('createForCustomer returns null when the customer belongs to another store (cross-tenant)', async () => {
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    const addr = await svc.createForCustomer('cust-owned-by-store-b', STORE_A, {
      street: '123',
      area: 'Salmiya',
    });
    expect(mockPrisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'cust-owned-by-store-b', storeId: STORE_A },
      select: { id: true },
    });
    expect(addr).toBeNull();
    expect(mockPrisma.customerAddress.create).not.toHaveBeenCalled();
  });

  it('create sets isDefault=true when first address for a same-store customer (control)', async () => {
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'cust1' });
    mockPrisma.customerAddress.findMany.mockResolvedValue([]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: true });
    await svc.createForCustomer('cust1', STORE_A, { street: '123', area: 'Salmiya' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '123', area: 'Salmiya', isDefault: true },
    });
  });

  it('create does NOT set isDefault when customer has existing addresses', async () => {
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'cust1' });
    mockPrisma.customerAddress.findMany.mockResolvedValue([{ id: 'a1', isDefault: true }]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: false });
    await svc.createForCustomer('cust1', STORE_A, { street: '456', area: 'Hawalli' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '456', area: 'Hawalli', isDefault: false },
    });
  });
});
