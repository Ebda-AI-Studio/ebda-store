import { prisma } from '@force/database';
import type { Prisma, Supplier, SupplierPaymentTerms } from '@prisma/client';

export interface CreateSupplierInput {
  storeId: string;
  name: string;
  nameAr?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: Record<string, unknown>;
  paymentTerms?: SupplierPaymentTerms;
  customTermsDays?: number;
  defaultCurrency?: string;
  notes?: string;
  notesAr?: string;
}

export async function createSupplier(input: CreateSupplierInput): Promise<Supplier> {
  return prisma.supplier.create({
    data: {
      storeId: input.storeId,
      name: input.name,
      nameAr: input.nameAr,
      contactName: input.contactName,
      phone: input.phone,
      email: input.email,
      address: (input.address ?? {}) as Prisma.InputJsonValue,
      paymentTerms: input.paymentTerms ?? 'net0',
      customTermsDays: input.customTermsDays,
      defaultCurrency: input.defaultCurrency ?? 'KWD',
      notes: input.notes,
      notesAr: input.notesAr,
    },
  });
}

export type UpdateSupplierInput = Partial<Omit<CreateSupplierInput, 'storeId'>> & {
  isActive?: boolean;
};

export async function updateSupplier(
  storeId: string,
  id: string,
  patch: UpdateSupplierInput
): Promise<Supplier> {
  const owned = await prisma.supplier.findFirst({
    where: { id, storeId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new Error(`Supplier ${id} not found in store ${storeId}`);
  return prisma.supplier.update({
    where: { id },
    data: {
      ...patch,
      address: patch.address ? (patch.address as Prisma.InputJsonValue) : undefined,
    },
  });
}

export async function listSuppliers(
  storeId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<Supplier[]> {
  return prisma.supplier.findMany({
    where: {
      storeId,
      deletedAt: null,
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: { name: 'asc' },
  });
}

export async function getSupplier(storeId: string, id: string): Promise<Supplier | null> {
  return prisma.supplier.findFirst({ where: { id, storeId, deletedAt: null } });
}

export async function softDeleteSupplier(storeId: string, id: string): Promise<void> {
  const owned = await prisma.supplier.findFirst({
    where: { id, storeId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new Error(`Supplier ${id} not found in store ${storeId}`);
  await prisma.supplier.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
}
