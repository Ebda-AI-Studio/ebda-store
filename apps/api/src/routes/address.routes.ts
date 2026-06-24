import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { kuwaitAddressSchema } from '@force/shared';
import { authenticate } from '../middleware/auth';

const router = Router();

// Validation schema for creating/updating an address.
//
// Derives from the canonical `kuwaitAddressSchema` in @force/shared which
// covers the full Kuwait field set (governorate / governorateAr / area /
// areaAr / state / ...).  The `isDefault` flag is the only address-book-
// specific addition.  This fixes the silent-drop bug where governorate +
// governorateAr + areaAr were accepted by the checkout form but stripped
// here before reaching the DB.
const addressSchema = kuwaitAddressSchema.extend({
  // Tighten validation messages for fields most likely to trigger errors.
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  address1: z.string().trim().min(1, 'Street address is required').max(500),
  country: z.string().trim().min(2, 'Country is required').max(60),
  // Address-book-specific flag not present in the base checkout schema.
  isDefault: z.boolean().optional(),
});

// GET /addresses — list the authenticated user's addresses
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const addresses = await prisma.address.findMany({
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
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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
      await prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    // If this is the user's first address, make it default automatically
    const existingCount = await prisma.address.count({ where: { userId } });
    const isDefault = data.isDefault ?? existingCount === 0;

    const address = await prisma.address.create({
      data: {
        userId,
        firstName: data.firstName,
        lastName: data.lastName,
        address1: data.address1,
        address2: data.address2,
        city: data.city,
        governorate: data.governorate ?? '',
        governorateAr: data.governorateAr ?? '',
        // `state` is required by the DB but optional in the API since Kuwait
        // doesn't really use it. Persist an empty string when omitted.
        state: data.state ?? '',
        area: data.area,
        areaAr: data.areaAr ?? '',
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
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Verify ownership
    const existing = await prisma.address.findUnique({ where: { id } });
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
      await prisma.address.updateMany({
        where: { userId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const address = await prisma.address.update({
      where: { id },
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
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Verify ownership
    const existing = await prisma.address.findUnique({ where: { id } });
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

    await prisma.address.delete({ where: { id } });

    // If the deleted address was default, promote the most recently created address
    if (existing.isDefault) {
      const next = await prisma.address.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
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
