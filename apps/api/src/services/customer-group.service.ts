/**
 * Customer groups — merchant-defined segments used for group-scoped pricing
 * and promotion/coupon targeting.
 *
 * Distinct from `CustomerRfmSnapshot`, which is computed analytics. This is a
 * manual assignment the merchant controls.
 *
 * Single-default invariant: at most one `isDefault` group per store. The
 * database enforces it with a partial unique index
 * (`customer_groups_one_default_per_store`); this service demotes the previous
 * default inside the same transaction so callers get a clean swap instead of a
 * 23505. Never rely on the service alone — concurrent writers would race, which
 * is exactly why the index exists underneath.
 */
import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';

export interface CustomerGroupInput {
  name: string;
  nameAr?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}

const groupSelect = {
  id: true,
  name: true,
  nameAr: true,
  isActive: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const CustomerGroupService = {
  async list(storeId: string) {
    const groups = await prisma.customerGroup.findMany({
      where: { storeId },
      select: { ...groupSelect, _count: { select: { customers: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    // Flatten the Prisma _count shape so the client sees a plain number.
    return groups.map(({ _count, ...g }) => ({ ...g, customerCount: _count.customers }));
  },

  async get(storeId: string, id: string) {
    const group = await prisma.customerGroup.findFirst({
      where: { id, storeId },
      select: { ...groupSelect, _count: { select: { customers: true } } },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');

    const { _count, ...rest } = group;
    return { ...rest, customerCount: _count.customers };
  },

  async create(storeId: string, input: CustomerGroupInput) {
    return prisma.$transaction(async tx => {
      if (input.isDefault) {
        await tx.customerGroup.updateMany({
          where: { storeId, isDefault: true },
          data: { isDefault: false },
        });
      }

      try {
        return await tx.customerGroup.create({
          data: {
            storeId,
            name: input.name,
            nameAr: input.nameAr ?? null,
            isActive: input.isActive ?? true,
            isDefault: input.isDefault ?? false,
          },
          select: groupSelect,
        });
      } catch (err) {
        throw translateUniqueViolation(err);
      }
    });
  },

  async update(storeId: string, id: string, input: Partial<CustomerGroupInput>) {
    return prisma.$transaction(async tx => {
      const existing = await tx.customerGroup.findFirst({
        where: { id, storeId },
        select: { id: true, isDefault: true },
      });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');

      if (input.isDefault === true && !existing.isDefault) {
        await tx.customerGroup.updateMany({
          where: { storeId, isDefault: true },
          data: { isDefault: false },
        });
      }

      // Refuse to unset the only default — a store with no default group has
      // nowhere to put new customers, and the UI offers no way back.
      if (input.isDefault === false && existing.isDefault) {
        throw new AppError(
          400,
          'DEFAULT_GROUP_REQUIRED',
          'Set another group as default instead of unsetting this one.'
        );
      }

      try {
        return await tx.customerGroup.update({
          where: { id, storeId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          },
          select: groupSelect,
        });
      } catch (err) {
        throw translateUniqueViolation(err);
      }
    });
  },

  /**
   * Delete a group. Members are NOT deleted — the FK is ON DELETE SET NULL, so
   * they simply become ungrouped.
   */
  async remove(storeId: string, id: string) {
    const existing = await prisma.customerGroup.findFirst({
      where: { id, storeId },
      select: { id: true },
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');

    await prisma.customerGroup.delete({ where: { id, storeId } });
  },

  /** Assign a customer to a group, or clear it when `groupId` is null. */
  async assignCustomer(storeId: string, customerId: string, groupId: string | null) {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, storeId },
      select: { id: true },
    });
    if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

    if (groupId) {
      const group = await prisma.customerGroup.findFirst({
        where: { id: groupId, storeId },
        select: { id: true },
      });
      // Cross-tenant group id must 404, never silently attach.
      if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
    }

    return prisma.customer.update({
      where: { id: customerId, storeId },
      data: { groupId },
      select: { id: true, groupId: true },
    });
  },

  /**
   * Assign a customer to a group by contact identity, materializing the
   * `customers` row if it does not exist yet.
   *
   * This is the bridge from the order/user-based admin customer views — which
   * hold a `User` id or guest shipping details, never a `Customer` id — to the
   * group model, which lives on the `customers` table. Without it, groups are
   * only assignable to seed data (nothing else writes `customers`).
   *
   * Phone is the primary GCC identifier, matched first; email is the fallback
   * (case-insensitive). At least one is required — an anonymous guest with no
   * contact detail has no stable identity to group.
   */
  async assignByIdentity(
    storeId: string,
    identity: {
      phone?: string | null;
      email?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    },
    groupId: string | null
  ) {
    const phone = identity.phone?.trim() || null;
    const email = identity.email?.trim() || null;
    if (!phone && !email) {
      throw new AppError(
        400,
        'IDENTITY_REQUIRED',
        'A phone or email is required to assign a group.'
      );
    }

    if (groupId) {
      const group = await prisma.customerGroup.findFirst({
        where: { id: groupId, storeId },
        select: { id: true },
      });
      // Cross-tenant group id must 404, never silently attach.
      if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
    }

    // Phone is the primary identity; fall back to a case-insensitive email
    // match so 'Foo@x.com' and 'foo@x.com' resolve to the same customer.
    const match: Prisma.CustomerWhereInput = phone
      ? { storeId, phone }
      : { storeId, email: { equals: email as string, mode: 'insensitive' } };

    const existing = await prisma.customer.findFirst({
      where: match,
      select: { id: true },
    });

    if (existing) {
      return prisma.customer.update({
        where: { id: existing.id, storeId },
        data: {
          groupId,
          // Backfill contact/name fields we now know but the row may lack.
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          ...(identity.firstName?.trim() ? { firstName: identity.firstName.trim() } : {}),
          ...(identity.lastName?.trim() ? { lastName: identity.lastName.trim() } : {}),
        },
        select: assignReturnSelect,
      });
    }

    try {
      // #1582: this runs inside the request's ambient tenant transaction
      // (assignByIdentity is reachable from POST under tenantContext). A
      // failed INSERT aborts that whole transaction (Postgres 25P02) — the
      // P2002 recovery below would then itself throw 25P02 instead of
      // recovering, and the request 500s. `withSavepoint` scopes the abort
      // to just this statement so the recovery can actually run.
      return await withSavepoint(() =>
        prisma.customer.create({
          data: {
            storeId,
            phone,
            email,
            firstName: identity.firstName?.trim() || '',
            lastName: identity.lastName?.trim() || '',
            groupId,
          },
          select: assignReturnSelect,
        })
      );
    } catch (err) {
      // Lost a concurrent upsert race against the (store, phone)/(store, email)
      // unique index — re-find and update instead of surfacing a 500.
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await prisma.customer.findFirst({ where: match, select: { id: true } });
        if (raced) {
          return prisma.customer.update({
            where: { id: raced.id, storeId },
            data: { groupId },
            select: assignReturnSelect,
          });
        }
      }
      throw err;
    }
  },
};

const assignReturnSelect = {
  id: true,
  groupId: true,
  group: { select: { id: true, name: true, nameAr: true } },
} as const;

/** Map the (store_id, name) unique violation to a useful 409. */
function translateUniqueViolation(err: unknown): unknown {
  const code = (err as { code?: string })?.code;
  if (code === 'P2002') {
    return new AppError(409, 'DUPLICATE_NAME', 'A group with this name already exists.');
  }
  return err;
}
