import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { egyptAddressSchema } from '@ebda/shared';
import { authenticate } from '../middleware/auth';
import { userContext } from '../middleware/tenant-context';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { atomicWrites } from '../lib/atomic-writes';

const router = Router();

// RLS cutover Phase 1c (docs/plans/2026-07-02-rls-cutover.md) — this router
// is mounted BARE at `/addresses` (routes/index.ts), with no `:storeId`/`:id`
// in its mount path, so `tenantContext` can never reach it (Express only
// populates req.params for params declared in the MOUNT path). Addresses are
// also user-scoped (FK user_id, no store_id column at all), so there's no
// store context to set even if it could.
//
// `router.use(authenticate)` + `router.use(userContext(...))` replace the
// per-route `authenticate` middleware below: every route in this file
// already required it individually, so hoisting it here is behavior-neutral
// and lets `userContext` read `req.user` for every handler. `userContext`
// sets `app.current_user_id` via `runInTenantContext(undefined, fn, userId)`
// (storeId undefined — addresses have none), giving the `rls_addresses_user`
// policy (20260702170000_rls_close_denyall_tables) a real per-user DB
// backstop once ebda_app is live. INERT today: `neondb_owner` (BYPASSRLS)
// skips every policy, so this changes zero request behavior — it only wraps
// each handler in the same interactive-tx pattern already used by
// `tenantContext`-wrapped routers.
//
// Cutover behavior note (NOT today): the PUT/DELETE ownership checks below
// (`existing.userId !== userId` → 403) currently 403 a cross-user probe.
// Once ebda_app is live, the RLS policy makes another user's address
// invisible to `findUnique` BEFORE that check ever runs, so the SAME probe
// will 404 instead of 403 — the DB backstop doing its job (don't reveal
// existence of another user's row). Expected; do not try to preserve 403.
router.use(authenticate);
router.use(userContext(req => req.user!.userId, addressStoreId));

/**
 * The store an address request belongs to: the customer token's store, else the `x-store-id` header (the wishlist's
 * convention). A Durable Object store keeps its address book in its DO; no store (or a Postgres store) is the unchanged prisma.
 */
function addressStoreId(req: Request): string | null {
  const fromToken = req.user?.storeId;
  if (fromToken) return fromToken;
  const h = req.headers['x-store-id'];
  return typeof h === 'string' && h ? h : null;
}
async function addressDb(req: Request) {
  const id = addressStoreId(req);
  return (id ? await storeDb(id) : prisma) as unknown as typeof prisma;
}
async function addressWriter(req: Request) {
  const id = addressStoreId(req);
  return (id ? await storeWriter(id) : prisma) as unknown as typeof prisma;
}

// Validation schema for creating/updating an address.
//
// Derives from the canonical `egyptAddressSchema` in @ebda/shared which
// covers the full Egypt field set (governorate / governorateAr / area /
// areaAr / state / ...).  The `isDefault` flag is the only address-book-
// specific addition.  This fixes the silent-drop bug where governorate +
// governorateAr + areaAr were accepted by the checkout form but stripped
// here before reaching the DB.
const addressSchema = egyptAddressSchema.extend({
  // Tighten validation messages for fields most likely to trigger errors.
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  address1: z.string().trim().min(1, 'Street address is required').max(500),
  country: z.string().trim().min(2, 'Country is required').max(60),
  // Address-book-specific flag not present in the base checkout schema.
  isDefault: z.boolean().optional(),
});

// GET /addresses — list the authenticated user's addresses
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const addresses = await (
      await addressDb(req)
    ).address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({
      success: true,
      data: { addresses },
    });
  } catch (error) {
    next(error);
  }
});

// POST /addresses — create a new address
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const parsed = addressSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid address data',
          details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
        },
      });
      return;
    }

    const data = parsed.data;

    const db = await addressDb(req);
    const w = await addressWriter(req);

    // If this is the user's first address, make it default automatically
    const existingCount = await db.address.count({ where: { userId } });
    const isDefault = data.isDefault ?? existingCount === 0;

    const createAddress = w.address.create({
      data: {
        userId,
        firstName: data.firstName,
        lastName: data.lastName,
        address1: data.address1,
        address2: data.address2,
        city: data.city,
        governorate: data.governorate ?? '',
        governorateAr: data.governorateAr ?? '',
        // `state` is required by the DB but optional in the API since Egypt
        // doesn't really use it. Persist an empty string when omitted.
        state: data.state ?? '',
        area: data.area,
        areaAr: data.areaAr ?? '',
        street: data.street,
        building: data.building,
        floor: data.floor,
        apartment: data.apartment,
        postalCode: data.postalCode,
        country: data.country,
        phone: data.phone,
        isDefault,
      },
    });
    let address;
    if (data.isDefault) {
      // If this address is being set as default, unset all other defaults in the same atomic batch
      [, address] = await atomicWrites(addressStoreId(req), w, [
        w.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
        createAddress,
      ]);
    } else {
      address = await createAddress;
    }

    res.status(201).json({
      success: true,
      data: { address },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /addresses/:id — update an existing address (ownership check)
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Verify ownership
    const existing = await (await addressDb(req)).address.findUnique({ where: { id, userId } });
    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Address not found' },
      });
      return;
    }

    if (existing.userId !== userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to update this address' },
      });
      return;
    }

    // Allow partial updates (isDefault-only update from handleSetDefault)
    const parsed = addressSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid address data',
          details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
        },
      });
      return;
    }

    const data = parsed.data;

    // If setting this address as default, unset others
    const w = await addressWriter(req);
    const updateAddress = w.address.update({
      where: { id, userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.address1 !== undefined && { address1: data.address1 }),
        ...(data.address2 !== undefined && { address2: data.address2 }),
        ...(data.city !== undefined && { city: data.city }),
        ...(data.governorate !== undefined && { governorate: data.governorate }),
        ...(data.governorateAr !== undefined && { governorateAr: data.governorateAr }),
        ...(data.state !== undefined && { state: data.state }),
        ...(data.area !== undefined && { area: data.area }),
        ...(data.areaAr !== undefined && { areaAr: data.areaAr }),
        ...(data.street !== undefined && { street: data.street }),
        ...(data.building !== undefined && { building: data.building }),
        ...(data.floor !== undefined && { floor: data.floor }),
        ...(data.apartment !== undefined && { apartment: data.apartment }),
        ...(data.postalCode !== undefined && { postalCode: data.postalCode }),
        ...(data.country !== undefined && { country: data.country }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
      },
    });
    let address;
    if (data.isDefault) {
      [, address] = await atomicWrites(addressStoreId(req), w, [
        w.address.updateMany({
          where: { userId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        }),
        updateAddress,
      ]);
    } else {
      address = await updateAddress;
    }

    res.json({
      success: true,
      data: { address },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /addresses/:id — delete an address (ownership check)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Verify ownership
    const existing = await (await addressDb(req)).address.findUnique({ where: { id, userId } });
    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Address not found' },
      });
      return;
    }

    if (existing.userId !== userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to delete this address' },
      });
      return;
    }

    const w = await addressWriter(req);
    // If the deleted address was default, promote the most recently created other address in the same atomic batch
    const next = existing.isDefault
      ? await (
          await addressDb(req)
        ).address.findFirst({
          where: { userId, id: { not: id } },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    if (next) {
      await atomicWrites(addressStoreId(req), w, [
        w.address.delete({ where: { id, userId } }),
        w.address.update({ where: { id: next.id, userId }, data: { isDefault: true } }),
      ]);
    } else {
      await w.address.delete({ where: { id, userId } });
    }

    res.json({
      success: true,
      data: { message: 'Address deleted successfully' },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
