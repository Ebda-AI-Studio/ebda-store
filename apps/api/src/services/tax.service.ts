import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { bustStoreCachesById } from './store.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';

/**
 * Issue 2212: `taxRatePercent` (and taxEnabled/taxIncludedInPrice) ride the
 * cached `public:store:*` payloads, so EVERY tax write must bust them — or
 * checkout displays a total computed at the old rate while order-create
 * charges the new one, for up to the Redis TTL plus the edge's s-maxage.
 * Deferred until AFTER the request's tenant transaction commits: a bust
 * before the commit lets a concurrent storefront read re-seed the cache from
 * the pre-write row for a full TTL. Outside a request it runs inline.
 */
function bustPublicTaxCaches(storeId: string): void {
  void deferAfterTenantCommit('tax.bustStoreCaches', () => bustStoreCachesById(storeId)).catch(
    err => logger.error({ err, storeId }, '[tax] public store cache bust failed')
  );
}

interface CreateTaxRateData {
  name: string;
  /** `null` clears the column; `undefined` leaves the stored value alone. */
  nameAr?: string | null;
  rate: number;
  country?: string | null;
  state?: string | null;
  priority?: number;
  isCompound?: boolean;
  isActive?: boolean;
}

type UpdateTaxRateData = Partial<CreateTaxRateData>;

interface TaxSettings {
  taxEnabled: boolean;
  taxIncludedInPrice: boolean;
  defaultTaxRate: number | null;
}

export class TaxService {
  /**
   * Get store tax settings
   */
  static async getSettings(storeId: string): Promise<TaxSettings> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        taxEnabled: true,
        taxIncludedInPrice: true,
        defaultTaxRate: true,
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    return {
      taxEnabled: store.taxEnabled,
      taxIncludedInPrice: store.taxIncludedInPrice,
      defaultTaxRate: store.defaultTaxRate ? Number(store.defaultTaxRate) : null,
    };
  }

  /**
   * Update store tax settings
   */
  static async updateSettings(storeId: string, settings: Partial<TaxSettings>) {
    const store = await prisma.store.update({
      where: { id: storeId },
      data: {
        taxEnabled: settings.taxEnabled,
        taxIncludedInPrice: settings.taxIncludedInPrice,
        defaultTaxRate: settings.defaultTaxRate,
      },
      select: {
        taxEnabled: true,
        taxIncludedInPrice: true,
        defaultTaxRate: true,
      },
    });
    bustPublicTaxCaches(storeId);

    return {
      taxEnabled: store.taxEnabled,
      taxIncludedInPrice: store.taxIncludedInPrice,
      defaultTaxRate: store.defaultTaxRate ? Number(store.defaultTaxRate) : null,
    };
  }

  /**
   * List tax rates for a store
   */
  static async listRates(storeId: string, includeInactive = false) {
    const where: Prisma.TaxRateWhereInput = { storeId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const rates = await prisma.taxRate.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    return rates.map(rate => ({
      ...rate,
      rate: Number(rate.rate),
    }));
  }

  /**
   * Get a single tax rate
   */
  static async getRate(storeId: string, rateId: string) {
    const rate = await prisma.taxRate.findFirst({
      where: { id: rateId, storeId },
    });

    if (!rate) {
      throw new AppError(404, 'NOT_FOUND', 'Tax rate not found');
    }

    return {
      ...rate,
      rate: Number(rate.rate),
    };
  }

  /**
   * Create a tax rate
   */
  static async createRate(storeId: string, data: CreateTaxRateData) {
    const rate = await prisma.taxRate.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        rate: data.rate,
        country: data.country,
        state: data.state,
        priority: data.priority || 0,
        isCompound: data.isCompound || false,
        isActive: data.isActive ?? true,
      },
    });
    bustPublicTaxCaches(storeId);

    return {
      ...rate,
      rate: Number(rate.rate),
    };
  }

  /**
   * Update a tax rate
   */
  static async updateRate(storeId: string, rateId: string, data: UpdateTaxRateData) {
    await this.getRate(storeId, rateId);

    const rate = await prisma.taxRate.update({
      where: { id: rateId, storeId },
      data: {
        name: data.name,
        nameAr: data.nameAr,
        rate: data.rate,
        country: data.country,
        state: data.state,
        priority: data.priority,
        isCompound: data.isCompound,
        isActive: data.isActive,
      },
    });
    bustPublicTaxCaches(storeId);

    return {
      ...rate,
      rate: Number(rate.rate),
    };
  }

  /**
   * Delete a tax rate
   */
  static async deleteRate(storeId: string, rateId: string) {
    await this.getRate(storeId, rateId);
    await prisma.taxRate.delete({ where: { id: rateId, storeId } });
    bustPublicTaxCaches(storeId);
  }

  /**
   * Toggle tax rate active status
   */
  static async toggleRate(storeId: string, rateId: string) {
    const rate = await this.getRate(storeId, rateId);

    const updated = await prisma.taxRate.update({
      where: { id: rateId, storeId },
      data: { isActive: !rate.isActive },
    });
    bustPublicTaxCaches(storeId);

    return {
      ...updated,
      rate: Number(updated.rate),
    };
  }
}
