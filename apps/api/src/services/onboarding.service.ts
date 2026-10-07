/**
 * Self-serve onboarding (SP5 task 2): slug availability, store creation for a
 * verified merchant, payment-method confirmation and go-live.
 *
 * The store is created `inactive` on a 14-day Growth trial (store_subscriptions
 * row written by the provisioning service), so it is NOT reachable at
 * `<slug>.ebda.app` (the storefront resolver only serves `active` stores) until
 * `goLive`. Reuses ProvisioningService so a self-serve store gets exactly the
 * seed rows a super-admin-provisioned one does (VAT rate, default category,
 * COD payment config, subscription).
 */
import { prisma, Prisma, withUser } from '@force/database';
import {
  storeHost,
  storefrontOrigin,
  validateStoreSlug,
  type StoreSlugErrorCode,
} from '@force/shared';
import { AppError } from '../middleware/error-handler';
import { ProvisioningService } from './provisioning.service';
import { bustStoreCaches } from './store.service';
import { SetupGuideService } from './setup-guide.service';
import { readInStoreContext } from '../lib/store-scoped-read';
import { assertOwnerMayCreateStore } from './plan-limit.service';
import { assertStoreCreationBudget, withStoreCreationLock } from './store-creation-limit';

/** A self-serve owner may hold this many stores (abuse bound; raise with plans). */
export const MAX_SELF_SERVE_STORES_PER_OWNER = 3;

export const SELF_SERVE_TEMPLATES = ['modern', 'classic', 'minimal', 'bold', 'elegant'] as const;
export type SelfServeTemplate = (typeof SELF_SERVE_TEMPLATES)[number];

export type SlugAvailability =
  | { slug: string; host: string; available: true }
  | {
      slug: string;
      host: string;
      available: false;
      reason: StoreSlugErrorCode | 'SLUG_TAKEN';
      message: string;
    };

export class OnboardingService {
  /**
   * `allowProtected` is the super_admin support-claim override: it lifts ONLY
   * the protected brand list (`SLUG_PROTECTED`); reserved labels never lift.
   */
  static async checkSlug(
    raw: string,
    opts: { allowProtected?: boolean } = {}
  ): Promise<SlugAvailability> {
    const slug = raw.trim().toLowerCase();
    const host = storeHost(slug);
    const valid = validateStoreSlug(slug, { allowProtected: opts.allowProtected });
    if (!valid.ok) {
      return { slug, host, available: false, reason: valid.code, message: valid.message };
    }
    // `slug` is unique across live AND soft-deleted stores, so check both.
    const taken = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
    if (taken) {
      return {
        slug,
        host,
        available: false,
        reason: 'SLUG_TAKEN',
        message: 'This store address is already taken',
      };
    }
    return { slug, host, available: true };
  }

  static async state(userId: string) {
    // As that user: `users` is RLS-scoped to app.current_user_id.
    const user = await withUser(userId, tx =>
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, firstName: true, emailVerified: true, phone: true },
      })
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const store = await prisma.store.findFirst({
      where: { ownerId: userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        domain: true,
        status: true,
        template: true,
        plan: true,
      },
    });

    let productCount = 0;
    let codEnabled = false;
    let subscriptionPlan: string | null = null;
    if (store) {
      // products, payment_configs and store_subscriptions are all store-scoped.
      const counts = await readInStoreContext(store.id, async () => ({
        products: await prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
        cod: await prisma.paymentConfig.count({
          where: { storeId: store.id, provider: 'cod', isEnabled: true },
        }),
        planCode:
          (
            await prisma.storeSubscription.findUnique({
              where: { storeId: store.id },
              select: { planCode: true },
            })
          )?.planCode ?? null,
      }));
      productCount = counts.products;
      codEnabled = counts.cod > 0;
      subscriptionPlan = counts.planCode;
    }

    return {
      user: {
        email: user.email,
        name: user.firstName,
        emailVerified: user.emailVerified,
      },
      store: store
        ? {
            id: store.id,
            name: store.name,
            slug: store.slug,
            status: store.status,
            template: store.template,
            host: storeHost(store.slug),
            url: storefrontOrigin({ slug: store.slug, domain: store.domain }),
            planCode: subscriptionPlan,
          }
        : null,
      productCount,
      codEnabled,
    };
  }

  static async createStore(
    owner: { userId: string; isSuperAdmin?: boolean },
    input: {
      name: string;
      nameAr?: string;
      slug: string;
      template?: SelfServeTemplate;
      language?: 'ar' | 'en';
    }
  ) {
    const user = await withUser(owner.userId, tx =>
      tx.user.findUnique({
        where: { id: owner.userId },
        select: { email: true, firstName: true, lastName: true, storeId: true },
      })
    );
    if (!user || user.storeId !== null) {
      throw new AppError(403, 'FORBIDDEN', 'Only merchant accounts can create a store');
    }

    const owned = await prisma.store.count({ where: { ownerId: owner.userId, deletedAt: null } });
    if (owned >= MAX_SELF_SERVE_STORES_PER_OWNER) {
      throw new AppError(409, 'STORE_LIMIT_REACHED', 'Store limit reached for this account');
    }

    const availability = await this.checkSlug(input.slug, {
      allowProtected: owner.isSuperAdmin === true,
    });
    if (!availability.available) {
      throw new AppError(
        availability.reason === 'SLUG_TAKEN' ? 409 : 400,
        availability.reason,
        availability.message
      );
    }

    const create = async () => {
      // Velocity cap (SP5 task 4): checked INSIDE the per-owner lock so a burst
      // of parallel creates cannot all read the same count.
      if (!owner.isSuperAdmin) await assertStoreCreationBudget(owner.userId);
      // Plan gate (locked pricing): a SECOND store needs a plan that allows it
      // (Business = 3). Also stops a Basic/Growth owner farming fresh Growth trials.
      if (!owner.isSuperAdmin) await assertOwnerMayCreateStore(owner.userId);
      const ownedNow = await prisma.store.count({
        where: { ownerId: owner.userId, deletedAt: null },
      });
      try {
        const result = await ProvisioningService.provisionStore({
          storeName: input.name,
          storeNameAr: input.nameAr,
          storeSlug: availability.slug,
          // The first store starts the 14-day Growth trial. An additional store
          // (only reachable on a plan that allows it) is covered by the owner's
          // Business plan and starts on it, with no second trial.
          plan: ownedNow > 0 ? 'enterprise' : 'professional',
          growthTrial: ownedNow === 0,
          status: 'inactive',
          template: input.template,
          ownerEmail: user.email,
          ownerName: `${user.firstName} ${user.lastName}`.trim() || user.email,
          settings: { defaultLanguage: input.language ?? 'ar' },
        });
        return result.store;
      } catch (err) {
        // Lost the slug race between the check above and the insert.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError(409, 'SLUG_TAKEN', 'This store address is already taken');
        }
        throw err;
      }
    };
    return owner.isSuperAdmin ? create() : withStoreCreationLock(owner.userId, create);
  }

  /**
   * Turn payment methods for the store (v1: COD only; gateways ship with SP6).
   * Refuses to leave the store with NO enabled method. Marks the guide's
   * "choose payment methods" item done: the merchant has now chosen.
   */
  static async setPaymentMethods(storeId: string, methods: { cod: boolean }) {
    const existing = await prisma.paymentConfig.findFirst({
      where: { storeId, provider: 'cod' },
      select: { id: true },
    });
    const otherEnabled = await prisma.paymentConfig.count({
      where: { storeId, isEnabled: true, provider: { not: 'cod' } },
    });
    if (!methods.cod && otherEnabled === 0) {
      throw new AppError(
        400,
        'NO_PAYMENT_METHOD',
        'Keep at least one payment method enabled so customers can check out'
      );
    }
    if (existing) {
      await prisma.paymentConfig.update({
        where: { id: existing.id },
        data: { isEnabled: methods.cod },
      });
    } else {
      await prisma.paymentConfig.create({
        data: {
          storeId,
          provider: 'cod',
          isEnabled: methods.cod,
          displayName: 'Cash on Delivery',
          displayNameAr: 'الدفع عند الاستلام',
          testMode: false,
          supportedMethods: ['cod'],
          supportedCurrencies: ['EGP'],
          fixedFee: 0,
          percentageFee: 0,
        },
      });
    }
    await SetupGuideService.setManual(storeId, 'payment', true);
    return { cod: methods.cod };
  }

  /** inactive -> active. Idempotent for an already-live store; a suspended store stays suspended. */
  static async goLive(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, slug: true, domain: true, status: true, name: true },
    });
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    if (store.status === 'suspended') {
      throw new AppError(403, 'STORE_SUSPENDED', 'This store is suspended');
    }
    if (store.status !== 'active') {
      const methods = await prisma.paymentConfig.count({ where: { storeId, isEnabled: true } });
      if (methods === 0) {
        throw new AppError(400, 'NO_PAYMENT_METHOD', 'Enable a payment method before going live');
      }
      await prisma.store.update({ where: { id: storeId }, data: { status: 'active' } });
      await bustStoreCaches(store.id, store.slug, store.domain);
    }
    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      status: 'active' as const,
      host: storeHost(store.slug),
      url: storefrontOrigin({ slug: store.slug, domain: store.domain }),
    };
  }
}
