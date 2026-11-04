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
import { customerRow, customerRows, isLiveCustomer } from '../lib/customer-directory';
import { prisma, Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';
import { invalidateB2bPricing } from '../lib/b2b-invalidate';

export interface CustomerGroupInput {
  name: string;
  nameAr?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  /** B2B pricing (needs the b2b.wholesale entitlement to turn on; the route checks it). */
  pricingMode?: 'none' | 'percent_off';
  discountBps?: number;
  requiresApproval?: boolean;
  isWholesale?: boolean;
}

const groupSelect = {
  id: true,
  name: true,
  nameAr: true,
  isActive: true,
  isDefault: true,
  pricingMode: true,
  discountBps: true,
  requiresApproval: true,
  isWholesale: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface AssignIdentity {
  /** The REGISTERED shopper (users.id) whose profile the merchant is on. When set it is the identity. */
  userId?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export const CustomerGroupService = {
  async list(storeId: string) {
    const groups = await prisma.customerGroup.findMany({
      where: { storeId },
      select: { ...groupSelect, _count: { select: { customers: true, priceTiers: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    // Flatten the Prisma _count shape so the client sees a plain number.
    return groups.map(({ _count, ...g }) => ({
      ...g,
      customerCount: _count.customers,
      // Shown in the delete confirmation: deleting a group deletes its price tiers.
      tierCount: _count.priceTiers,
    }));
  },

  async get(storeId: string, id: string) {
    const group = await prisma.customerGroup.findFirst({
      where: { id, storeId },
      select: { ...groupSelect, _count: { select: { customers: true, priceTiers: true } } },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');

    const { _count, ...rest } = group;
    return { ...rest, customerCount: _count.customers, tierCount: _count.priceTiers };
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
            pricingMode: input.pricingMode ?? 'none',
            discountBps: input.discountBps ?? 0,
            requiresApproval: input.requiresApproval ?? false,
            isWholesale: input.isWholesale ?? false,
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
        invalidateB2bPricing(storeId); // pricing mode / %, isActive and isWholesale change what members pay (deferred to commit)
        return await tx.customerGroup.update({
          where: { id, storeId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
            ...(input.pricingMode !== undefined ? { pricingMode: input.pricingMode } : {}),
            ...(input.discountBps !== undefined ? { discountBps: input.discountBps } : {}),
            ...(input.requiresApproval !== undefined
              ? { requiresApproval: input.requiresApproval }
              : {}),
            ...(input.isWholesale !== undefined ? { isWholesale: input.isWholesale } : {}),
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
    invalidateB2bPricing(storeId); // members return to retail; the group's tiers cascade away
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

    const updated = await prisma.customer.update({
      where: { id: customerId, storeId },
      data: { groupId },
      select: { id: true, groupId: true },
    });
    invalidateB2bPricing(storeId); // membership changes what this customer pays
    return updated;
  },

  /**
   * Wholesale approval (B2B Task 5, Ruling B2B-2c): attach a REGISTERED shopper to a group through the `customers.user_id`
   * link. The identity is the applicant's session user id, taken from the application row, NEVER a typed phone / email;
   * this method does not call `assignByIdentity` and cannot touch another person's CRM row. The shopper's own CRM row is
   * matched by `user_id`, else created linked to them (account email where free, NO phone, since a profile phone is
   * unverified and a linked row that held a wholesaler's phone would be matched by it later).
   */
  async linkApprovedBuyer(storeId: string, userId: string, groupId: string) {
    const group = await prisma.customerGroup.findFirst({
      where: { id: groupId, storeId },
      select: { id: true },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
    const doShopper = await customerRow(storeId, userId);
    const shopper =
      doShopper !== undefined
        ? doShopper && isLiveCustomer(doShopper)
          ? doShopper
          : null
        : await prisma.user.findFirst({
            where: { id: userId, storeId, role: 'customer', status: 'active', deletedAt: null },
            select: { id: true, email: true, firstName: true, lastName: true },
          });
    if (!shopper)
      throw new AppError(
        409,
        'APPLICANT_INACTIVE',
        'The applicant account is suspended or deleted.'
      );

    const linked = await prisma.customer.findFirst({
      where: { storeId, userId },
      select: { id: true },
    });
    let row;
    if (linked) {
      row = await prisma.customer.update({
        where: { id: linked.id, storeId },
        data: { groupId },
        select: assignReturnSelect,
      });
    } else {
      const emailTaken = await prisma.customer.findFirst({
        where: { storeId, email: { equals: shopper.email, mode: 'insensitive' } },
        select: { id: true },
      });
      row = await withSavepoint(() =>
        prisma.customer.create({
          data: {
            storeId,
            userId,
            email: emailTaken ? null : shopper.email,
            phone: null,
            firstName: shopper.firstName || '',
            lastName: shopper.lastName || '',
            groupId,
          },
          select: assignReturnSelect,
        })
      );
    }
    invalidateB2bPricing(storeId); // the buyer now prices at the group's wholesale terms
    return row;
  },

  /**
   * Wholesale revoke: take the shopper OUT of wholesale, whatever group they are in now (review I4). A later manual move to
   * another WHOLESALE group must not survive a revoke, or the buyer would keep wholesale prices and wholesale-only
   * visibility. They land in the store's default non-wholesale group (or none). Returns `removed: false` when the buyer is
   * already in no wholesale group (moved out by hand, or the link is gone): the end state is the one asked for, and the
   * caller reports it instead of pretending a change happened. Membership is read per request, so open carts re-price to
   * retail at the next read; the persisted lines of orders already created are untouched.
   */
  async unlinkBuyer(
    storeId: string,
    userId: string
  ): Promise<{ removed: boolean; fromGroupId: string | null }> {
    const linked = await prisma.customer.findFirst({
      where: { storeId, userId },
      select: { id: true, groupId: true, group: { select: { isWholesale: true } } },
    });
    if (!linked || !linked.groupId || !linked.group?.isWholesale) {
      return { removed: false, fromGroupId: linked?.groupId ?? null };
    }
    const dflt = await prisma.customerGroup.findFirst({
      where: { storeId, isDefault: true, isWholesale: false },
      select: { id: true },
    });
    await prisma.customer.update({
      where: { id: linked.id, storeId },
      data: { groupId: dflt?.id ?? null },
      select: { id: true },
    });
    invalidateB2bPricing(storeId);
    return { removed: true, fromGroupId: linked.groupId };
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
  async assignByIdentityImpl(storeId: string, identity: AssignIdentity, groupId: string | null) {
    const phone = identity.phone?.trim() || null;
    const email = identity.email?.trim() || null;
    const userId = identity.userId || null;
    if (!userId && !phone && !email) {
      throw new AppError(
        400,
        'IDENTITY_REQUIRED',
        'A registered customer, a phone or an email is required to assign a group.'
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

    // Ruling B2B-2e - this method NEVER rewrites an existing row's contact or name fields.
    //  * userId given (the merchant is on a REGISTERED shopper's profile): the identity is the `customers.user_id` link.
    //    Match that row; else create the shopper's own row linked to the user, with the account email where it is free
    //    and NO phone, so a shopper who set someone else's phone on their profile gets their own row, not the other person's.
    //  * no userId (a guest key, or a CRM identity): match phone first then email, attach the group to that row, and
    //    change nothing else on it. Such a row has no user_id, so it grants no group PRICE or promotion benefit to anyone
    //    who types its phone; it is only ever used when the merchant explicitly picks it.
    if (userId) {
      const doShopper = await customerRow(storeId, userId);
      const shopper =
        doShopper !== undefined
          ? doShopper && doShopper.deletedAt === null
            ? doShopper
            : null
          : await prisma.user.findFirst({
              where: { id: userId, storeId, role: 'customer', deletedAt: null },
              select: { id: true, email: true, phone: true, firstName: true, lastName: true },
            });
      if (!shopper) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

      const linked = await prisma.customer.findFirst({
        where: { storeId, userId: shopper.id },
        select: { id: true },
      });
      if (linked) {
        return prisma.customer.update({
          where: { id: linked.id, storeId },
          data: { groupId },
          select: assignReturnSelect,
        });
      }
      const free = async (field: 'phone' | 'email', value: string | null) => {
        if (!value) return null;
        const taken = await prisma.customer.findFirst({
          where:
            field === 'phone'
              ? { storeId, phone: value }
              : { storeId, email: { equals: value, mode: 'insensitive' } },
          select: { id: true },
        });
        return taken ? null : value;
      };
      try {
        return await withSavepoint(async () =>
          prisma.customer.create({
            data: {
              storeId,
              userId: shopper.id,
              // The phone is NEVER copied onto a linked row: a shopper's profile phone is self-edited and unverified, and a
              // linked row that held a wholesaler's phone would be matched by that phone later (design review I-3).
              phone: null,
              email: await free('email', shopper.email ?? email ?? null),
              firstName: identity.firstName?.trim() || shopper.firstName || '',
              lastName: identity.lastName?.trim() || shopper.lastName || '',
              groupId,
            },
            select: assignReturnSelect,
          })
        );
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          const raced = await prisma.customer.findFirst({
            where: { storeId, userId: shopper.id },
            select: { id: true },
          });
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
    }

    // Design review I-3: without a userId only UNLINKED rows (user_id NULL: CRM / guest rows) are candidates. A row linked to
    // a registered shopper is that shopper's, and a typed phone / email must never steer a group onto it.
    const match: Prisma.CustomerWhereInput = phone
      ? { storeId, userId: null, phone }
      : { storeId, userId: null, email: { equals: email as string, mode: 'insensitive' } };
    const existing =
      (await prisma.customer.findFirst({ where: match, select: { id: true } })) ??
      (email && phone
        ? await prisma.customer.findFirst({
            where: { storeId, userId: null, email: { equals: email, mode: 'insensitive' } },
            select: { id: true },
          })
        : null);

    if (existing) {
      return prisma.customer.update({
        where: { id: existing.id, storeId },
        data: { groupId },
        select: assignReturnSelect,
      });
    }

    // Only a LINKED row matches this phone / email: refuse, loudly, rather than attach the group to someone else's account
    // or trip the unique index with a 500. The merchant assigns the group from that shopper's profile instead.
    const linkedOnly = await prisma.customer.findFirst({
      where: {
        storeId,
        userId: { not: null },
        OR: [
          ...(phone ? [{ phone }] : []),
          ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { id: true },
    });
    if (linkedOnly) {
      throw new AppError(
        409,
        'IDENTITY_LINKED_TO_ACCOUNT',
        "This phone or email belongs to a registered shopper. Open that shopper's profile to assign their group."
      );
    }

    try {
      // #1582: this runs inside the request's ambient tenant transaction; a failed INSERT aborts it (25P02), so the
      // P2002 recovery below needs a savepoint to be reachable.
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
      // Lost a concurrent upsert race against the (store, phone)/(store, email) unique index: re-find, attach only.
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

  /** See `assignByIdentityImpl`. Wrapper so every return path invalidates the cached public payload after the write. */
  async assignByIdentity(storeId: string, identity: AssignIdentity, groupId: string | null) {
    const row = await CustomerGroupService.assignByIdentityImpl(storeId, identity, groupId);
    invalidateB2bPricing(storeId); // membership changes what this customer pays
    return row;
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
