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

  async listForCustomer(customerId: string) {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createForCustomer(customerId: string, input: CreateAddressInput) {
    const existing = await this.listForCustomer(customerId);
    // First address → mark default so the bot has a sensible pre-selection
    const isDefault = existing.length === 0;
    return this.prisma.customerAddress.create({
      data: { customerId, ...input, isDefault },
    });
  }
}
