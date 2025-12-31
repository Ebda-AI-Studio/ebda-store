import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

interface CreateShippingZoneData {
  name: string;
  nameAr?: string;
  areas: string[];
  areasAr?: string[];
  deliveryFee: number;
  freeShippingThreshold?: number;
  estimatedDays?: number;
  estimatedDaysMin?: number;
  estimatedDaysMax?: number;
  position?: number;
  isActive?: boolean;
}

type UpdateShippingZoneData = Partial<CreateShippingZoneData>;

interface ListShippingZonesOptions {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

export class ShippingService {
  static async list(storeId: string, options: ListShippingZonesOptions = {}) {
    const { page = 1, limit = 50, isActive } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ShippingZoneWhereInput = { storeId };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [zones, total] = await Promise.all([
      prisma.shippingZone.findMany({
        where,
        skip,
        take: limit,
        orderBy: { position: 'asc' },
      }),
      prisma.shippingZone.count({ where }),
    ]);

    return {
      zones,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, zoneId: string) {
    const zone = await prisma.shippingZone.findFirst({
      where: { id: zoneId, storeId },
    });

    if (!zone) {
      throw new AppError(404, 'NOT_FOUND', 'Shipping zone not found');
    }

    return zone;
  }

  static async create(storeId: string, data: CreateShippingZoneData) {
    // Get the highest position for this store
    const maxPosition = await prisma.shippingZone.aggregate({
      where: { storeId },
      _max: { position: true },
    });

    const zone = await prisma.shippingZone.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        areas: data.areas,
        areasAr: data.areasAr || [],
        deliveryFee: data.deliveryFee,
        freeShippingThreshold: data.freeShippingThreshold,
        estimatedDays: data.estimatedDays,
        estimatedDaysMin: data.estimatedDaysMin,
        estimatedDaysMax: data.estimatedDaysMax,
        position: data.position ?? (maxPosition._max.position || 0) + 1,
        isActive: data.isActive ?? true,
      },
    });

    return zone;
  }

  static async update(storeId: string, zoneId: string, data: UpdateShippingZoneData) {
    await this.getById(storeId, zoneId);

    const zone = await prisma.shippingZone.update({
      where: { id: zoneId },
      data: {
        name: data.name,
        nameAr: data.nameAr,
        areas: data.areas,
        areasAr: data.areasAr,
        deliveryFee: data.deliveryFee,
        freeShippingThreshold: data.freeShippingThreshold,
        estimatedDays: data.estimatedDays,
        estimatedDaysMin: data.estimatedDaysMin,
        estimatedDaysMax: data.estimatedDaysMax,
        position: data.position,
        isActive: data.isActive,
      },
    });

    return zone;
  }

  static async delete(storeId: string, zoneId: string) {
    await this.getById(storeId, zoneId);

    await prisma.shippingZone.delete({
      where: { id: zoneId },
    });
  }

  static async toggleActive(storeId: string, zoneId: string) {
    const zone = await this.getById(storeId, zoneId);

    const updatedZone = await prisma.shippingZone.update({
      where: { id: zoneId },
      data: { isActive: !zone.isActive },
    });

    return updatedZone;
  }

  static async reorder(storeId: string, zoneIds: string[]) {
    // Verify all zones belong to this store
    const zones = await prisma.shippingZone.findMany({
      where: { storeId, id: { in: zoneIds } },
    });

    if (zones.length !== zoneIds.length) {
      throw new AppError(400, 'INVALID_ZONES', 'Some shipping zones not found');
    }

    // Update positions
    await prisma.$transaction(
      zoneIds.map((id, index) =>
        prisma.shippingZone.update({
          where: { id },
          data: { position: index },
        })
      )
    );

    return this.list(storeId);
  }

  /**
   * Calculate shipping cost for an order based on delivery area
   */
  static async calculateShipping(storeId: string, area: string, orderTotal: number) {
    // Find matching zone by area
    const zones = await prisma.shippingZone.findMany({
      where: { storeId, isActive: true },
      orderBy: { position: 'asc' },
    });

    // Try to find exact match for area
    let matchedZone = zones.find(zone => {
      const areas = zone.areas as string[];
      return areas.some(
        a => a.toLowerCase() === area.toLowerCase() || area.toLowerCase().includes(a.toLowerCase())
      );
    });

    // If no match, use the first zone as default (usually "All Areas")
    if (!matchedZone && zones.length > 0) {
      matchedZone = zones[0];
    }

    if (!matchedZone) {
      return {
        zone: null,
        shippingCost: 0,
        freeShipping: false,
        estimatedDays: null,
      };
    }

    // Check if order qualifies for free shipping
    const freeShipping = matchedZone.freeShippingThreshold
      ? orderTotal >= matchedZone.freeShippingThreshold
      : false;

    return {
      zone: {
        id: matchedZone.id,
        name: matchedZone.name,
        nameAr: matchedZone.nameAr,
      },
      shippingCost: freeShipping ? 0 : matchedZone.deliveryFee,
      freeShipping,
      estimatedDays: matchedZone.estimatedDays,
      estimatedDaysMin: matchedZone.estimatedDaysMin,
      estimatedDaysMax: matchedZone.estimatedDaysMax,
    };
  }

  /**
   * Get public shipping zones for storefront
   */
  static async getPublicZones(storeId: string) {
    const zones = await prisma.shippingZone.findMany({
      where: { storeId, isActive: true },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        nameAr: true,
        areas: true,
        areasAr: true,
        deliveryFee: true,
        freeShippingThreshold: true,
        estimatedDays: true,
        estimatedDaysMin: true,
        estimatedDaysMax: true,
      },
    });

    return zones;
  }
}
