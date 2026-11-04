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
import { cfBindings } from '../cf/bindings';
import { getAccountState } from '../lib/identity-client';
import { recordReferral } from './billing/grants.service';
import { storeDb, storeRepo, storeUpdate, storeWriter, storeWritesToDo } from '../lib/repo-factory';
import { requirePlatformDb } from '../lib/platform-db';
import { onAccessD1, ownedStoreIdsD1 } from './platform/access-d1';
import { sendOnboardingStepToCi } from '../lib/ci/emit';
import { prisma, Prisma, withUser, withStore, runInStoreScope } from '@ebda/database';
import {
  getLook,
  builtLooks,
  defaultNewStoreLook,
  isBuiltSkin,
  type LookDefinition,
  storeCreatedEventId,
  storeHost,
  storefrontOrigin,
  validateStoreSlug,
  type StoreSlugErrorCode,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { ProvisioningService } from './provisioning.service';
import { bustStoreCaches, StoreService } from './store.service';
import { SetupGuideService } from './setup-guide.service';
import { readInStoreContext } from '../lib/store-scoped-read';
import { storeIdBySlug } from '../lib/definer';
import { assertOwnerMayCreateStore, ownerStoreAllowance } from './plan-limit.service';
import { countOwnerStores, storeCreateOnDo } from '../lib/store-create-do';
import { assertStoreCreationBudget, withStoreCreationLock } from './store-creation-limit';
import { assertStoreMayGoLive } from './billing/go-live-gate';
import {
  getSubscriptionBillingState,
  loadPayablePlan,
} from './billing/subscription-billing.service';
import { DEFAULT_TRIAL_CHOICE, type TrialChoice } from './billing/trial';
import { emitEbdaConversion } from './ebda-ads-emit';

/** A self-serve owner may hold this many stores (abuse bound; raise with plans). */
export const MAX_SELF_SERVE_STORES_PER_OWNER = 3;

/**
 * Bare-skin choice, kept for callers that predate looks (new clients send `lookId`). Only skins
 * a BUILT look renders with are accepted (looks registry); the five legacy Force skins are not.
 */
export type SelfServeTemplate = LookDefinition['skin'];

export type SlugAvailability =
  | { slug: string; host: string; available: true }
  | {
      slug: string;
      host: string;
      available: false;
      reason: StoreSlugErrorCode | 'SLUG_TAKEN';
      message: string;
    };

/**
 * The signed-in merchant's account facts. After the `access` cutover the account lives in the identity service (Postgres `users`
 * is a stale copy), so it is read there; before it, the RLS-scoped Postgres read, byte for byte as before.
 * `storeId` is null for a merchant account (a shopper account is tied to one store).
 */
async function merchantAccount(userId: string) {
  if (await onAccessD1()) {
    const a = await getAccountState(userId);
    if (!a || a.status !== 'active') return null;
    return {
      id: a.id,
      email: a.email,
      firstName: a.firstName,
      lastName: a.lastName,
      emailVerified: a.emailVerified,
      phone: a.phone,
      storeId: a.role === 'customer' ? ('customer' as string | null) : (null as string | null),
    };
  }
  return withUser(userId, tx =>
    tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        emailVerified: true,
        phone: true,
        storeId: true,
      },
    })
  );
}

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
    // `stores` is under RLS (R-EBDA-005): the probe is the `ebda_store_id_by_slug` definer.
    if (await storeIdBySlug(slug)) {
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
    const user = await merchantAccount(userId);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const storeSelect = {
      id: true,
      name: true,
      slug: true,
      domain: true,
      status: true,
      template: true,
      look: true,
      plan: true,
    } as const;
    // After the `access` cutover the owner's store row is the D1 directory row (no Postgres `users` scope to open).
    const store = (await onAccessD1())
      ? await (
          await requirePlatformDb()
        ).store.findFirst({
          where: { ownerId: userId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: storeSelect,
        })
      : await withUser(userId, tx =>
          tx.store.findFirst({
            where: { ownerId: userId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: storeSelect,
          })
        );

    let productCount = 0;
    let codEnabled = false;
    let subscriptionPlan: string | null = null;
    if (store) {
      // products, payment_configs and store_subscriptions are all store-scoped.
      const counts = await readInStoreContext(store.id, async () => ({
        products: await (
          await storeDb(store.id)
        ).product.count({ where: { storeId: store.id, deletedAt: null } }),
        cod: await (
          await storeDb(store.id)
        ).paymentConfig.count({
          where: { storeId: store.id, provider: 'cod', isEnabled: true },
        }),
        // a DO store's subscription row is in the platform D1; a Postgres store keeps its own table
        planCode:
          (
            await (
              (await storeRepo(store.id)).backend === 'do'
                ? (await requirePlatformDb()).storeSubscription
                : prisma.storeSubscription
            ).findUnique({
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
            look: store.look,
            host: storeHost(store.slug),
            url: storefrontOrigin({ slug: store.slug, domain: store.domain }),
            planCode: subscriptionPlan,
          }
        : null,
      productCount,
      codEnabled,
      billing: store ? await getSubscriptionBillingState(store.id) : null,
    };
  }

  static async createStore(
    owner: { userId: string; isSuperAdmin?: boolean },
    input: {
      name: string;
      nameAr?: string;
      slug: string;
      template?: SelfServeTemplate;
      /** A look from the registry: sets look + skin and shapes the home page (wins over `template`). */
      lookId?: string;
      language?: 'ar' | 'en';
      /** Plan chosen at signup (billed at trial end); defaults to Growth monthly. */
      plan?: TrialChoice;
      /** Referrer's store slug (FOUNDING-1): recorded only for the owner's first store. */
      ref?: string;
    }
  ) {
    const user = await merchantAccount(owner.userId);
    if (!user || user.storeId !== null) {
      throw new AppError(403, 'FORBIDDEN', 'Only merchant accounts can create a store');
    }

    const owned = await countOwnerStores(owner.userId, async () =>
      (await onAccessD1())
        ? (await ownedStoreIdsD1(owner.userId)).length
        : withUser(owner.userId, tx =>
            tx.store.count({ where: { ownerId: owner.userId, deletedAt: null } })
          )
    );
    if (owned >= MAX_SELF_SERVE_STORES_PER_OWNER) {
      throw new AppError(409, 'STORE_LIMIT_REACHED', 'Store limit reached for this account');
    }

    // The chosen plan must be payable (public, priced) BEFORE anything is created.
    const trialChoice = input.plan ?? DEFAULT_TRIAL_CHOICE;
    const { plan: chosen } = await loadPayablePlan(trialChoice.planCode, trialChoice.interval);
    if (!chosen.isPublic) {
      throw new AppError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be purchased');
    }

    // No look asked for = the registry default (Qamar's first built look), never the DB default.
    // A bare `template` picks that template's first built look. Unbuilt looks are refused.
    const look =
      input.lookId !== undefined
        ? getLook(input.lookId)
        : (builtLooks().find(l => l.skin === input.template) ?? defaultNewStoreLook());
    if (input.lookId !== undefined && !look) {
      throw new AppError(400, 'INVALID_LOOK', 'Unknown look');
    }
    if (!look || look.status !== 'built' || !isBuiltSkin(look.skin)) {
      throw new AppError(400, 'LOOK_NOT_AVAILABLE', 'This look is not available for new stores');
    }
    if (input.template !== undefined && !isBuiltSkin(input.template)) {
      throw new AppError(
        400,
        'TEMPLATE_NOT_AVAILABLE',
        'This template is not available for new stores'
      );
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
      const ownedNow = await countOwnerStores(owner.userId, () =>
        withUser(owner.userId, tx =>
          tx.store.count({ where: { ownerId: owner.userId, deletedAt: null } })
        )
      );
      try {
        const result = await ProvisioningService.provisionStore({
          storeName: input.name,
          storeNameAr: input.nameAr,
          storeSlug: availability.slug,
          // The first store starts the 14-day Growth trial. An additional store
          // (only reachable on a plan that allows it) is covered by the owner's
          // Business plan and starts on it, with no second trial.
          plan: ownedNow > 0 ? 'enterprise' : 'professional',
          maxOwnedStores:
            owner.isSuperAdmin || !storeCreateOnDo()
              ? null
              : Math.min(
                  MAX_SELF_SERVE_STORES_PER_OWNER,
                  (await ownerStoreAllowance(owner.userId)).allowance ??
                    MAX_SELF_SERVE_STORES_PER_OWNER
                ),
          growthTrial: ownedNow === 0,
          trialChoice,
          status: 'inactive',
          template: look.skin as SelfServeTemplate,
          ownerEmail: user.email,
          ownerName: `${user.firstName} ${user.lastName}`.trim() || user.email,
          settings: { defaultLanguage: input.language ?? 'ar' },
        });
        // Ebda's own ads funnel: the browser fires StoreCreated with the same id. Fail-open.
        if (!owner.isSuperAdmin) {
          await emitEbdaConversion({
            name: 'StoreCreated',
            eventId: storeCreatedEventId(result.store.id),
            userId: owner.userId,
            storeId: result.store.id,
          });
        }
        // FOUNDING-1: remember who referred this store (best effort; the reward is paid at the first PAID month).
        if (input.ref && ownedNow === 0 && !owner.isSuperAdmin) {
          await recordReferral(result.store.id, input.ref).catch(err =>
            logger.warn(
              { err, storeId: result.store.id },
              '[ONBOARDING] recording the referral failed'
            )
          );
        }
        await sendOnboardingStepToCi(result.store.id, 'store_created');
        // Only a failed look application is reported (the default look is applied like a chosen one).
        const lookApplied = await this.applyChosenLook(result.store.id, look.id, owner.userId);
        return { store: result.store, lookApplied };
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
   * Put the chosen look on a just-provisioned store. Onboarding runs with NO ambient tenant
   * context, so the work is bound to the new store's scope (applyLook reads/writes the store and
   * its home-page revisions). A brand-new store is "genuinely fresh", so the home page is
   * published. Best effort: the store already exists and is usable, and a retry of the whole
   * request would only hit SLUG_TAKEN, so a failure is logged and reported as `lookApplied: false`
   * (the client asks the merchant to pick a look again) rather than failing the creation.
   */
  private static async applyChosenLook(
    storeId: string,
    lookId: string,
    userId: string
  ): Promise<boolean> {
    try {
      await runInStoreScope(storeId, () =>
        StoreService.applyLook(storeId, lookId, { design: 'reset' }, userId)
      );
      return true;
    } catch (err) {
      logger.error(
        { err, code: err instanceof AppError ? err.code : undefined, storeId, lookId },
        '[ONBOARDING] applying the chosen look failed'
      );
      return false;
    }
  }

  /**
   * Turn payment methods for the store (v1: COD only; gateways ship with SP6).
   * Refuses to leave the store with NO enabled method. Marks the guide's
   * "choose payment methods" item done: the merchant has now chosen.
   */
  static async setPaymentMethods(storeId: string, methods: { cod: boolean }) {
    const existing = await (
      await storeDb(storeId)
    ).paymentConfig.findFirst({
      where: { storeId, provider: 'cod' },
      select: { id: true },
    });
    const otherEnabled = await (
      await storeDb(storeId)
    ).paymentConfig.count({
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
      await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: { isEnabled: methods.cod },
      });
    } else {
      await (
        await storeWriter(storeId)
      ).paymentConfig.create({
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
    await sendOnboardingStepToCi(storeId, 'payment_methods');
    return { cod: methods.cod };
  }

  /** inactive -> active. Idempotent for an already-live store; a suspended store stays suspended. */
  static async goLive(storeId: string) {
    const store = await (
      await storeDb(storeId)
    ).store.findUnique({
      where: { id: storeId },
      select: { id: true, slug: true, domain: true, status: true, name: true },
    });
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    if (store.status === 'suspended') {
      throw new AppError(403, 'STORE_SUSPENDED', 'This store is suspended');
    }
    if (store.status !== 'active') {
      // Billing first (Ruling EBDA-FUNNEL-5): an active trial with a saved card,
      // a pay-at-trial-end trial, a paid plan, or an admin-granted plan.
      await assertStoreMayGoLive(storeId);
      const methods = await (
        await storeDb(storeId)
      ).paymentConfig.count({ where: { storeId, isEnabled: true } });
      if (methods === 0) {
        throw new AppError(400, 'NO_PAYMENT_METHOD', 'Enable a payment method before going live');
      }
      const statusArgs = { where: { id: storeId }, data: { status: 'active' as const } };
      // A DO store's status lives in D1/DO: no Postgres transaction is opened for it.
      if (await storeWritesToDo(storeId)) await storeUpdate(prisma, statusArgs);
      else await withStore(storeId, tx => storeUpdate(tx, statusArgs));
      await bustStoreCaches(store.id, store.slug, store.domain);
      await sendOnboardingStepToCi(store.id, 'went_live');
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
