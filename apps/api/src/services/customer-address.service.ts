import type { PrismaClient } from '@prisma/client';

export type CreateAddressInput = {
  street: string;
  area: string;
  block?: string;
  governorate?: string;
  buildingNumber?: string;
  label?: string;
  notes?: string;
};

/**
 * CRUD for CustomerAddress records — created during the WhatsApp native
 * catalog bot checkout flow when a customer provides a new delivery address.
 *
 * The first address a customer adds is automatically marked as default so
 * the bot can pre-select it without asking the customer to pick.
 */
export class CustomerAddressService {
  constructor(private prisma: PrismaClient) {}

  /**
   * `storeId` MUST come from the authenticated tenant context (e.g.
   * `req.bridgeStore.id`), never from a request body/query field. Addresses
   * have no direct storeId column — scope via the owning customer's storeId
   * so a customerId from another tenant returns nothing instead of leaking
   * cross-tenant delivery-address PII.
   */
  async listForCustomer(customerId: string, storeId: string) {
    return this.prisma.customerAddress.findMany({
      where: { customerId, customer: { storeId } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createForCustomer(customerId: string, storeId: string, input: CreateAddressInput) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, storeId },
      select: { id: true },
    });
    if (!customer) return null;

    const existing = await this.listForCustomer(customerId, storeId);
    // First address → mark default so the bot has a sensible pre-selection
    const isDefault = existing.length === 0;
    return this.prisma.customerAddress.create({
      data: { customerId, ...input, isDefault },
    });
  }
}
