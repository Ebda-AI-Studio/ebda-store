import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  prisma,
  Prisma,
  StoreStatus,
  type StoreTemplate,
  acrossStores,
  scopeTransaction,
  withMoneyTx,
  withStore,
} from '@ebda/database';
import { ensureAdminUser, storeIdByDomain, storeIdBySlug } from '../lib/definer';
import { bustStoreCaches } from './store.service';
import { syncStoreDirectoryFromPg } from '../lib/store-directory-sync';
import { syncSubscriptionFromLegacyPlan } from './plan-sync';
import { startSignupTrial, type TrialChoice } from './billing/trial';
import { assertStoreSlug, deriveStoreSlug } from '../lib/store-slug';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { resolveDomainService } from './domain-provider';
import logger from '../lib/logger';
import { inngest } from '../lib/inngest/client';
import { maskEmail } from '../lib/pii-mask';
import {
  isValidTimeZone,
  slugifyWithFallback,
  REGION,
  storefrontOrigin,
  isReservedSlug,
  NEW_STORE_LAYOUT_SETTINGS,
  defaultNewStoreLook,
  isBuiltSkin,
} from '@ebda/shared';
import { storeDb, storeUpdate, storeWriter } from '../lib/repo-factory';
import {
  finishDoStoreCreate,
  insertDoStore,
  rollbackDoStore,
  storeCreateOnDo,
} from '../lib/store-create-do';

// ==========================================
// Store Provisioning Service
// Handles new store creation and setup
// ==========================================

export interface ProvisionStoreInput {
  // Store details
  storeName: string;
  storeSlug?: string;
  domain?: string;
  // Frontend hosting provider for the custom domain. Cloudflare-for-SaaS is the
  // only provider (Vercel cancelled 2026-07); kept optional for signature compat.
  domainProvider?: 'cloudflare';
  plan?: 'free' | 'starter' | 'professional' | 'enterprise';
  /**
   * Initial store status. Defaults to `active` (super-admin provisioning).
   * Self-serve onboarding creates the store `inactive` (unreachable at
   * `<slug>.ebda.app`) and flips it live at the final step.
   */
  status?: 'active' | 'inactive';
  /** Self-serve only: starts Growth trial inside the provisioning transaction. */
  growthTrial?: boolean;
  /** Self-serve only: the plan + interval chosen at signup, billed at trial end. */
  trialChoice?: TrialChoice;
  /** D1 path only: atomic plan gate (the owner's store allowance; null/absent = unlimited). */
  maxOwnedStores?: number | null;
  /** Initial storefront skin: must be one a BUILT look renders with. Defaults to the registry default (Qamar). */
  template?: string;
  storeNameAr?: string;

  // Owner details
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;

  // Optional settings
  settings?: {
    theme?: string;
    currency?: string;
    timezone?: string;
    defaultLanguage?: 'ar' | 'en';
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
      status = 'active',
      template: requestedTemplate,
      storeNameAr,
      ownerEmail,
      ownerName,
      ownerPassword,
      settings,
    } = input;

    // A new store starts on a built Ebda skin, never a legacy Force one and never the DB default.
    const template = requestedTemplate ?? defaultNewStoreLook().skin;
    if (!isBuiltSkin(template)) {
      throw new AppError(
        400,
        'TEMPLATE_NOT_AVAILABLE',
        'This template is not available for new stores'
      );
    }

    // An explicit slug is the store's `<slug>.ebda.app`: validate it (format +
    // reserved list) and refuse with a stable SLUG_* code. A generated one is
    // coerced into a valid, unreserved slug.
    // Protected brand names (SLUG_PROTECTED) are NOT re-checked here: this runs
    // for super_admin provisioning (the support-claim path, which may grant a
    // protected name) and for self-serve onboarding, which already refused a
    // protected slug for non-super_admin before calling in. Reserved labels and
    // format are still enforced.
    const slug = storeSlug
      ? assertStoreSlug(storeSlug, { allowProtected: true })
      : this.generateSlug(storeName);

    // Check if slug is available
    // `stores` is under RLS (R-EBDA-005): uniqueness probes go through definers.
    if (await storeIdBySlug(slug)) {
      throw new AppError(400, 'SLUG_TAKEN', 'Store URL is already taken');
    }

    // Check if domain is available (if provided)
    if (domain) {
      if (await storeIdByDomain(domain)) {
        throw new AppError(400, 'DOMAIN_TAKEN', 'Domain is already in use');
      }
    }

    // Add domain to the resolved provider BEFORE the DB transaction. If the
    // provider succeeds but the transaction below fails (slug collision in
    // concurrent provision, owner email race, etc.), we MUST remove the domain —
    // a phantom domain serves traffic + bills us but is invisible to admin since
    // no Store row references it. Provider = input.domainProvider → env default.
    const domainSvc = resolveDomainService({ domainProvider: input.domainProvider });
    let domainAdded = false;
    if (domain) {
      try {
        await domainSvc.addDomain(domain);
        domainAdded = true;
      } catch (error) {
        logger.error(
          { err: error, domain, provider: domainSvc.providerName },
          'Failed to add domain to provider during provisioning'
        );
      }
    }

    // Generate temporary password if not provided
    const tempPassword = ownerPassword || this.generateTempPassword();

    // Hash password before entering transaction
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    // N-18 (Ruling NZ-D11): on D1 + the Durable Object the store has NO Postgres row. The owner is identity (Postgres until the
    // identity track), so only the owner is found-or-created in a Postgres transaction; the store, its subscription / trial, VAT
    // rate, COD config, chart of accounts and default category are D1 + DO writes (lib/store-create-do.ts).
    const onDo = storeCreateOnDo();
    const provisionOnDo = async () => {
      const nameParts = ownerName.trim().split(' ');
      // The owner is found-or-created in a Postgres transaction that stays OPEN until the D1 + DO create succeeded: a failed create
      // rolls the owner back too (a retry is then a fresh account that gets its temporary password), as on the single-transaction
      // Postgres path. If the COMMIT itself fails after the store exists, the store is rolled back (below).
      let finished: string | undefined;
      try {
        return await withMoneyTx(prisma, async tx => {
          const owner = await ensureAdminUser(
            {
              email: ownerEmail,
              passwordHash,
              firstName: nameParts[0],
              lastName: nameParts.slice(1).join(' ') || '',
              role: 'store_admin',
              emailVerified: false,
            },
            tx
          );
          const { timezone: requestedZone, ...settingsRest } = settings ?? {};
          const id = await insertDoStore({
            name: storeName,
            nameAr: storeNameAr ?? null,
            slug,
            domain: domain ?? null,
            domainProvider: input.domainProvider ?? null,
            ownerId: owner.id,
            status,
            plan,
            template,
            ...(isValidTimeZone(requestedZone) ? { timezone: requestedZone } : {}),
            settings: {
              theme: settingsRest.theme || 'default',
              currency: settingsRest.currency || REGION.currency,
              ...settingsRest,
              defaultLanguage:
                (settingsRest as { defaultLanguage?: string }).defaultLanguage ||
                REGION.defaultLocale,
            },
            theme: {},
            layoutSettings: NEW_STORE_LAYOUT_SETTINGS as Record<string, unknown>,
            vatRateHundredths: REGION.defaultVatBps,
            trial: input.growthTrial ? { choice: input.trialChoice } : undefined,
            maxOwnedStores: input.maxOwnedStores ?? null,
            cod: {
              name: 'Cash on Delivery',
              nameAr: 'الدفع عند الاستلام',
              currency: REGION.currency,
            },
          });
          const created = await finishDoStoreCreate(id, {
            slug,
            domain: domain ?? null,
            extra: async () => {
              await (
                await storeWriter(id)
              ).category.create({
                data: {
                  storeId: id,
                  name: 'Products',
                  slug: 'products',
                  description: 'All products',
                  position: 0,
                },
              });
            },
          });
          finished = id;
          return {
            store: created as { id: string; name: string; slug: string; domain: string | null },
            owner,
            isNewUser: owner.created,
          };
        });
      } catch (e) {
        if (finished) await rollbackDoStore(finished, 'owner-commit');
        throw e;
      }
    };

    let result;
    try {
      // Create store, owner, and default category in a single transaction.
      // The provisioning transaction creates rows in RLS-protected tables
      // (categories, payment_configs) for a storeId that does not exist yet, so
      // it cannot start inside runInTenantContext: it creates the owner and the
      // store first, then switches its own transaction to the new store with a
      // transaction-local set_config before touching the tenant tables.
      result = onDo
        ? await provisionOnDo()
        : await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
            // Find-or-create the owner in the ADMIN namespace (users.store_id NULL).
            // Admin accounts are not visible from a store scope and the store does
            // not exist yet, so this is the `ebda_admin_user_ensure` definer, run on
            // THIS transaction (it is just a function call). An existing account is
            // used as is, whatever its role, exactly as before.
            const nameParts = ownerName.trim().split(' ');
            const owner = await ensureAdminUser(
              {
                email: ownerEmail,
                passwordHash,
                firstName: nameParts[0],
                lastName: nameParts.slice(1).join(' ') || '',
                role: 'store_admin',
                emailVerified: false,
              },
              tx
            );
            const isNewUser = owner.created;

            // `timezone` governs the store's tax periods (Ruling FRT-2), so it goes
            // to the `stores.timezone` COLUMN — validated, else the column default.
            // It is deliberately NOT copied into the `settings` JSON, where no
            // code reads it (issue 2412).
            const { timezone: requestedZone, ...settingsRest } = settings ?? {};
            // The store row is inserted AS ITS OWNER: the `stores` policy's WITH CHECK and the
            // code-level tenant guard (R-EBDA-003) both admit a new store only when `owner_id`
            // is the acting user. No caller can supply that scope (self-serve onboarding runs
            // with no tenant context; super-admin provisioning acts as the operator, not as the
            // new owner), so the transaction binds it itself, to the owner it just resolved.
            const store = await scopeTransaction(tx, { userId: owner.id }, () =>
              tx.store.create({
                data: {
                  name: storeName,
                  slug,
                  domain,
                  // Operator-assigned (super_admin) domains are trusted: active at once.
                  ...(domain ? { domainStatus: 'active', domainVerifiedAt: new Date() } : {}),
                  domainProvider: input.domainProvider ?? null,
                  ...(storeNameAr ? { nameAr: storeNameAr } : {}),
                  ownerId: owner.id,
                  status,
                  template: template as StoreTemplate,
                  // A new store starts with NO trust strip: `items: []` marks the
                  // strip merchant-owned (empty = hidden). Stores that predate this
                  // have no `items` key and keep the fixed defaults (see
                  // TrustStripSettings.items). No migration needed.
                  layoutSettings: NEW_STORE_LAYOUT_SETTINGS,
                  plan,
                  ...(isValidTimeZone(requestedZone) ? { timezone: requestedZone } : {}),
                  settings: {
                    theme: settingsRest.theme || 'default',
                    currency: settingsRest.currency || REGION.currency,
                    ...settingsRest,
                    // Arabic-first unless the caller said otherwise (spread above wins if present).
                    defaultLanguage:
                      (settingsRest as { defaultLanguage?: string }).defaultLanguage ||
                      REGION.defaultLocale,
                  },
                },
              })
            );

            // The store exists now: from here the transaction acts as it, so the rows
            // below satisfy the strict store policies (set_config, transaction-local) and
            // the code-level tenant guard sees the store (`scopeTransaction`).
            return scopeTransaction(tx, { storeId: store.id, userId: owner.id }, async () => {
              // Subscription row for the plan the operator chose (SP5 plans engine).
              // Super-admin provisioning is platform-controlled, so a custom domain
              // here is NOT plan-gated (the operator is assigning the plan).
              await syncSubscriptionFromLegacyPlan(tx, store.id, store.plan);
              if (input.growthTrial) await startSignupTrial(tx, store.id, input.trialChoice);

              // Default VAT (Ebda: `REGION.defaultVatBps` = 14%), seeded as an
              // INACTIVE editable rate: a new store starts with VAT OFF and no active
              // rate (ruling TAX-2). It is activated after the store's VAT
              // registration is verified by a super-admin.
              await tx.taxRate.create({
                data: {
                  storeId: store.id,
                  name: 'VAT',
                  nameAr: 'ضريبة القيمة المضافة',
                  rate: REGION.defaultVatBps / 100,
                  isActive: false,
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

              // Provision Cash on Delivery as the default payment method.
              // Without this row the storefront's POST /payments/create returns 400
              // (COD_NOT_AVAILABLE) and customers can't check out — even though the
              // UI offers COD by default. Store owners can disable / configure a fee
              // later via /admin/payment-settings.
              await tx.paymentConfig.create({
                data: {
                  storeId: store.id,
                  provider: 'cod',
                  isEnabled: true,
                  displayName: 'Cash on Delivery',
                  displayNameAr: 'الدفع عند الاستلام',
                  testMode: false,
                  supportedMethods: ['cod'],
                  supportedCurrencies: [REGION.currency],
                  fixedFee: 0,
                  percentageFee: 0,
                },
              });

              return { store, owner, isNewUser };
            });
          });

      // Transaction committed — disarm the domain rollback so a successful
      // provision is never undone by a downstream error (e.g. welcome email
      // failure handled below).
      domainAdded = false;
    } catch (error) {
      // Compensating action: if we registered the domain with the provider but
      // the DB transaction failed, remove it so we don't strand a phantom domain
      // billing + serving traffic with no admin visibility. Fire-and-forget;
      // log on failure so ops can manually clean up.
      if (domainAdded && domain) {
        const domainToRollback = domain;
        void domainSvc
          .removeDomain(domainToRollback)
          .catch(rollbackErr =>
            logger.error(
              { err: rollbackErr, domain: domainToRollback, provider: domainSvc.providerName },
              '[PROVISIONING] Failed to roll back domain after transaction failure — manual cleanup required'
            )
          );
      }
      throw error;
    }

    // Hotfix N-22: lookups read D1, so the committed store must be mirrored there or it 404s. A failure is loud (the store
    // exists in Postgres; the retry of the idempotent mirror converges).
    if (!onDo) await syncStoreDirectoryFromPg(result.store.id);

    // Self-serve (signup trial): start the lifecycle-emails run (setup nudges, trial recap). The
    // transaction has committed; an enqueue failure is logged, never fails the provisioning.
    if (input.growthTrial) {
      void inngest
        .send({ name: 'store/self-serve-provisioned', data: { storeId: result.store.id } })
        .catch((err: unknown) =>
          logger.warn(
            { err, storeId: result.store.id },
            '[PROVISIONING] lifecycle-emails event not sent'
          )
        );
    }

    // Store is provisioned — fire-and-forget the welcome email so SMTP latency
    // can't stall the provisioning API response.
    if (result.isNewUser) {
      void EmailService.sendWelcome(result.store.id, {
        email: ownerEmail,
        name: ownerName,
      }).catch(err =>
        logger.error(
          { err, email: maskEmail(ownerEmail) },
          'Failed to send welcome email during provisioning'
        )
      );
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
        temporaryPassword: result.isNewUser ? tempPassword : undefined,
      },
      urls: {
        storefront: storefrontOrigin({ slug: result.store.slug, domain }),
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
      /** When set, only stores owned by this user are returned (store_admin scoping). */
      ownerId?: string;
    } = {}
  ) {
    const { page = 1, limit = 20, status, search, ownerId } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.StoreWhereInput = {};
    if (ownerId) where.ownerId = ownerId;
    if (status) where.status = status as StoreStatus;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { domain: { contains: search, mode: 'insensitive' } },
      ];
    }

    // `_count.products` / `_count.orders` read RLS-protected tables, so a
    // correlated count from the stores table would see no rows. The page of
    // stores is read first (under the caller's user scope: a super_admin's
    // 'platform-operator' hatch or the owner; `stores` is under RLS, R-EBDA-005), then each store on the page is counted inside its
    // OWN store scope.
    const [pageStores, total] = await Promise.all([
      prisma.store.findMany({
        where,
        skip,
        take: limit,
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.store.count({ where }),
    ]);
    const counts = new Map(
      (
        await acrossStores(
          async storeId => {
            const [products, orders] = await Promise.all([
              (await storeDb(storeId)).product.count({ where: { storeId } }),
              prisma.order.count({ where: { storeId } }),
            ]);
            return { products, orders };
          },
          { storeIds: pageStores.map(s => s.id) }
        )
      ).map(r => [r.storeId, r.value])
    );
    const stores = pageStores.map(s => ({
      ...s,
      _count: counts.get(s.id) ?? { products: 0, orders: 0 },
    }));

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
    return withStore(storeId, () => this.readStoreStats(storeId));
  }

  private static async readStoreStats(storeId: string) {
    const [productCount, orderCount, customerCount, revenueResult] = await Promise.all([
      (await storeDb(storeId)).product.count({ where: { storeId } }),
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
    const store = await withStore(storeId, tx =>
      storeUpdate(tx, {
        where: { id: storeId },
        data: { status },
      })
    );
    // Account status is NEVER-stale (adversarial audit P1-7) — bust the
    // public resolve/slug/id caches + fire the storefront revalidate purge
    // on EVERY status writer, or a suspended store keeps serving the cached
    // active storefront for up to the TTL.
    await bustStoreCaches(store.id, store.slug, store.domain);
    return store;
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
  /**
   * Store slug for a provisioned store.
   *
   * Delegates to the shared `slugifyWithFallback` rather than keeping a fifth
   * private copy: the local version stripped to `[a-z0-9]`, so an Arabic-only
   * store name produced '' and the caller persisted an empty slug — the same
   * defect that put '' and '-1'..'-4' product slugs on a live store.
   */
  private static generateSlug(name: string): string {
    const derived = deriveStoreSlug(slugifyWithFallback(name, 'store', { ascii: true }));
    // A name that derives a reserved label ("Support") gets a suffix so the
    // store is created at a legal address instead of failing.
    return isReservedSlug(derived) ? `${derived}-1` : derived;
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
