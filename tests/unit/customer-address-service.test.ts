import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerAddressService } from '@api/services/customer-address.service';

const mockPrisma = {
  customerAddress: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
};

describe('CustomerAddressService', () => {
  const svc = new CustomerAddressService(mockPrisma as any);
  beforeEach(() => vi.clearAllMocks());

  it('listForCustomer returns addresses sorted by isDefault then createdAt', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([
      { id: 'a1', label: 'Home', isDefault: true },
      { id: 'a2', label: 'Office', isDefault: false },
    ]);
    const addresses = await svc.listForCustomer('cust1');
    expect(mockPrisma.customerAddress.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust1' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    expect(addresses).toHaveLength(2);
  });

  it('create sets isDefault=true when first address for customer', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: true });
    const addr = await svc.createForCustomer('cust1', { street: '123', area: 'Salmiya' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '123', area: 'Salmiya', isDefault: true },
    });
  });

  it('create does NOT set isDefault when customer has existing addresses', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([{ id: 'a1', isDefault: true }]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: false });
    await svc.createForCustomer('cust1', { street: '456', area: 'Hawalli' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '456', area: 'Hawalli', isDefault: false },
    });
  });
});
