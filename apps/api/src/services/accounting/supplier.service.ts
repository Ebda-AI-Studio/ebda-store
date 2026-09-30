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
  leadTimeDays?: number;
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
      leadTimeDays: input.leadTimeDays ?? 7,
      notes: input.notes,
      notesAr: input.notesAr,
    },
  });
}

/**
 * The nullable text columns accept an explicit `null` to CLEAR the stored
 * value; `undefined` (key omitted) leaves it untouched. `{ ...patch }` below
 * hands both straight to Prisma, which reads them the same way. Create has
 * nothing to clear, so `CreateSupplierInput` stays `string | undefined`.
 */
export type UpdateSupplierInput = Partial<
  Omit<
    CreateSupplierInput,
    | 'storeId'
    | 'nameAr'
    | 'contactName'
    | 'phone'
    | 'email'
    | 'notes'
    | 'notesAr'
    | 'customTermsDays'
  >
> & {
  nameAr?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  notesAr?: string | null;
  /** null clears custom terms when the supplier moves to a standard term. */
  customTermsDays?: number | null;
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
