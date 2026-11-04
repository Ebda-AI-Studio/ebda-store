import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { egyptAddressSchema } from '@ebda/shared';
import { authenticate } from '../middleware/auth';
import { userContext } from '../middleware/tenant-context';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALIDATED_STORE = Symbol('ebda.addressStore');

/**
 * Ruling NZ-SF-5: a shopper's address book lives in the customer's StoreDO (per store, like the per-store account). The store is
 * decided ONCE, here, from the verified token and nothing else:
 *  - a customer always uses `req.user.storeId` (the store the token was issued for). An `X-Store-ID` header is never trusted:
 *    absent is fine, present must be ONE well-formed id equal to the token's store, otherwise 403 (an array, a duplicate that
 *    Node joins with a comma, or any other shape is a 400). A customer token with no store is a 400 `STORE_REQUIRED`.
 *  - every other role ignores `X-Store-ID` entirely and keeps the Postgres address book it always had.
 * The one validated id is what `userContext` and `storeWriter` both receive.
 */
function resolveAddressStore(req: Request, _res: Response, next: NextFunction): void {
  try {
    let store: string | undefined;
    if (req.user?.role === 'customer') {
      const claim = (req.user as { storeId?: string }).storeId;
      if (typeof claim !== 'string' || !UUID_RE.test(claim))
        throw new AppError(400, 'STORE_REQUIRED', 'Store is required for the address book');
      const header = req.headers['x-store-id'];
      if (header !== undefined) {
        if (typeof header !== 'string' || !UUID_RE.test(header))
          throw new AppError(400, 'INVALID_STORE', 'X-Store-ID must be a single store id');
        if (header.toLowerCase() !== claim.toLowerCase())
          throw new AppError(403, 'STORE_MISMATCH', 'This account belongs to another store');
      }
      store = claim.toLowerCase();
    }
    (req as unknown as Record<symbol, string | undefined>)[VALIDATED_STORE] = store;
    next();
  } catch (e) {
    next(e);
  }
}

const addressStoreId = (req: Request): string | undefined =>
  (req as unknown as Record<symbol, string | undefined>)[VALIDATED_STORE];

/** The address client of the validated store: its DO for a DO store, `prisma` for a Postgres store or a non-customer token. */
async function addressDb(req: Request) {
  const storeId = addressStoreId(req);
  if (!storeId) return prisma;
  return (await storeWriter(storeId)) as unknown as typeof prisma;
}

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
router.use(resolveAddressStore);
router.use(
  userContext(
    req => req.user!.userId,
    req => addressStoreId(req)
  )
);

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

    // If this address is being set as default, unset all other defaults first
    if (data.isDefault) {
      await (
        await addressDb(req)
      ).address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    // If this is the user's first address, make it default automatically
    const existingCount = await (await addressDb(req)).address.count({ where: { userId } });
    const isDefault = data.isDefault ?? existingCount === 0;

    const address = await (
      await addressDb(req)
    ).address.create({
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
    if (data.isDefault) {
      await (
        await addressDb(req)
      ).address.updateMany({
        where: { userId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const address = await (
      await addressDb(req)
    ).address.update({
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

    await (await addressDb(req)).address.delete({ where: { id, userId } });

    // If the deleted address was default, promote the most recently created address
    if (existing.isDefault) {
      const next = await (
        await addressDb(req)
      ).address.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await (
          await addressDb(req)
        ).address.update({ where: { id: next.id, userId }, data: { isDefault: true } });
      }
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
