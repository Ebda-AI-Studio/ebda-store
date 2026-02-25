import crypto from 'crypto';
import { prisma, Prisma, StoreStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { VercelDomainService } from './vercel-domain.service';
import logger from '../lib/logger';

// ==========================================
// Store Provisioning Service
// Handles new store creation and setup
// ==========================================

export interface ProvisionStoreInput {
  // Store details
  storeName: string;
  storeSlug?: string;
  domain?: string;
  plan?: 'free' | 'starter' | 'professional' | 'enterprise';

  // Owner details
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;

  // Optional settings
  settings?: {
    theme?: string;
    currency?: string;
    timezone?: string;
  };
}

export interface ProvisioningResult {
  store: {
    id: string;
    name: string;
    slug: string;
    domain: string | null;
  };
  owner: {
    id: string;
    email: string;
    temporaryPassword?: string;
  };
  urls: {
    storefront: string;
    admin: string;
  };
}

export class ProvisioningService {
  /**
   * Provision a new store with owner account
   */
  static async provisionStore(input: ProvisionStoreInput): Promise<ProvisioningResult> {
    const {
      storeName,
      storeSlug,
      domain,
      plan = 'starter',
      ownerEmail,
      ownerName,
      ownerPassword,
      settings,
    } = input;

    // Generate slug if not provided
    const slug = storeSlug || this.generateSlug(storeName);

    // Check if slug is available
    const existingStore = await prisma.store.findUnique({
      where: { slug },
    });

    if (existingStore) {
      throw new AppError(400, 'SLUG_TAKEN', 'Store URL is already taken');
    }

    // Check if domain is available (if provided)
    if (domain) {
      const existingDomain = await prisma.store.findUnique({
        where: { domain },
      });

      if (existingDomain) {
        throw new AppError(400, 'DOMAIN_TAKEN', 'Domain is already in use');
      }
    }

    // Add domain to Vercel (non-blocking — don't fail store creation)
    if (domain) {
      try {
        await VercelDomainService.addDomain(domain);
      } catch (error) {
        logger.error({ err: error, domain }, 'Failed to add domain to Vercel during provisioning');
      }
    }

    // Check if owner email exists
    const existingUser = await prisma.user.findUnique({
      where: { email: ownerEmail },
    });

    // Generate temporary password if not provided
    const tempPassword = ownerPassword || this.generateTempPassword();

    // Create store and owner in transaction
    const result = await prisma.$transaction(async tx => {
      let owner;

      if (existingUser) {
        // Use existing user as owner
        owner = existingUser;
      } else {
        // Create new owner account
        const authResult = await AuthService.register({
          email: ownerEmail,
          name: ownerName,
          password: tempPassword,
        });
        owner = authResult.user;

        // Upgrade to store_admin role
        await tx.user.update({
          where: { id: owner.id },
          data: { role: 'store_admin' },
        });
      }

      // Create the store
      const store = await tx.store.create({
        data: {
          name: storeName,
          slug,
          domain,
          ownerId: owner.id,
          status: 'active',
          plan,
          settings: {
            theme: settings?.theme || 'default',
            currency: settings?.currency || 'USD',
            timezone: settings?.timezone || 'UTC',
            ...(settings || {}),
          },
        },
      });

      // Create default category
      await tx.category.create({
        data: {
          storeId: store.id,
          name: 'Products',
          slug: 'products',
          description: 'All products',
          position: 0,
        },
      });

      return { store, owner, isNewUser: !existingUser };
    });

    // Send welcome email to new owner
    if (!existingUser) {
      try {
        await EmailService.sendWelcome({
          email: ownerEmail,
          name: ownerName,
        });
      } catch (error) {
        logger.error(
          { err: error, email: ownerEmail },
          'Failed to send welcome email during provisioning'
        );
      }
    }

    return {
      store: {
        id: result.store.id,
        name: result.store.name,
        slug: result.store.slug,
        domain: result.store.domain,
      },
      owner: {
        id: result.owner.id,
        email: result.owner.email,
        temporaryPassword: !existingUser ? tempPassword : undefined,
      },
      urls: {
        storefront: domain ? `https://${domain}` : `${process.env.WEB_URL}/${result.store.slug}`,
        admin: `${process.env.ADMIN_URL}`,
      },
    };
  }

  /**
   * List all stores (admin only)
   */
  static async listStores(
    options: {
      page?: number;
      limit?: number;
      status?: string;
      search?: string;
    } = {}
  ) {
    const { page = 1, limit = 20, status, search } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.StoreWhereInput = {};
    if (status) where.status = status as StoreStatus;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { domain: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where,
        skip,
        take: limit,
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          _count: {
            select: { products: true, orders: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.store.count({ where }),
    ]);

    return {
      stores,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get store statistics
   */
  static async getStoreStats(storeId: string) {
    const [productCount, orderCount, customerCount, revenueResult] = await Promise.all([
      prisma.product.count({ where: { storeId } }),
      prisma.order.count({ where: { storeId } }),
      prisma.order
        .groupBy({
          by: ['customerId'],
          where: { storeId },
        })
        .then(r => r.length),
      prisma.order.aggregate({
        where: { storeId, paymentStatus: 'paid' },
        _sum: { total: true },
      }),
    ]);

    return {
      products: productCount,
      orders: orderCount,
      customers: customerCount,
      revenue: revenueResult._sum.total || 0,
    };
  }

  /**
   * Update store status
   */
  static async updateStoreStatus(storeId: string, status: 'active' | 'inactive' | 'suspended') {
    return prisma.store.update({
      where: { id: storeId },
      data: { status },
    });
  }

  /**
   * Delete store (soft delete by suspending)
   */
  static async suspendStore(storeId: string) {
    return this.updateStoreStatus(storeId, 'suspended');
  }

  /**
   * Generate URL-safe slug from name
   */
  private static generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  /**
   * Generate temporary password
   */
  private static generateTempPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    const randomBytes = crypto.randomBytes(12);
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(randomBytes[i] % chars.length);
    }
    return password;
  }
}
