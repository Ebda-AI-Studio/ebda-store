import { Router, Request, Response, NextFunction } from 'express';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { z } from 'zod/v3';
import { prisma, Prisma } from '@ebda/database';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { encryption } from '../services/encryption.service';
import { auditLog } from '../middleware/security';
import { PaymentService } from '../services/payment.service';
import { getAuthUser } from '../utils/store-helpers';
import { paymentSettingsRouteContext } from '../middleware/tenant-context';

import {
  REGION,
  PAYMENT_PROVIDER_CODES,
  getProviderEntry,
  codSettingsSchema,
  fawrySettingsSchema,
  instapaySettingsBaseSchema,
  instapaySettingsSchema,
  kashierSettingsSchema,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { providerHealth } from '../services/payment-providers/provider-health';
import { reportConnectionCheck } from '../services/provider-verification.service';
import { describeConnectionCheck, type ConnectionCheckView } from '@ebda/shared';
import {
  applyCredentialUpdate,
  assertEnableAllowed,
  assertMayConfigure,
  connectableEntry,
  publicPaymentConfig,
  runConnectionTest,
} from '../services/payment-providers/provider-connection.service';
const router = Router();

// Mounted bare at '/payment-settings' in routes/index.ts — the global
// (super-admin, storeId-less) routes above stay outside tenant context by
// design. Every '/store/:storeId/...' route below sets RLS tenant context
// once Express resolves :storeId, matching coupon.routes.ts /
// shipping.routes.ts. Closes the one F2-GAP router with zero DB backstop
// over PaymentConfig (encrypted provider secrets) — see
// docs/audits/2026-07-16-rls-cutover-readiness-map.md §2/§6#3. Confirmed no
// external I/O in these handlers (no fetch/3rd-party calls; that only
// happens in the storeId-less /:provider/test route above).
// The Test connection route calls the gateway, so it runs under store scope instead of the
// request transaction (`paymentSettingsRouteContext`); every other store route keeps ONE tx.
router.param('storeId', paymentSettingsRouteContext);

// ==========================================
// Validation Schemas
// ==========================================

const paymentConfigSchema = z.object({
  // A catalog code (PROVIDERS-1: the list lives in @ebda/shared, not in a DB enum).
  provider: z
    .string()
    .refine(code => PAYMENT_PROVIDER_CODES.includes(code), { message: 'Unknown payment provider' }),
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  // BE:S-10: bounded display strings and method/currency lists (they used to spread unconstrained into the row).
  displayName: z.string().max(120).optional(),
  displayNameAr: z.string().max(120).optional(),
  apiKey: z.string().optional(),
  secretKey: z.string().optional(),
  merchantId: z.string().optional(),
  webhookSecret: z.string().optional(),
  testMode: z.boolean().default(true),
  supportedMethods: z.array(z.string().min(1).max(40)).max(20).default([]),
  supportedCurrencies: z
    .array(z.string().regex(/^[A-Za-z]{3}$/))
    .max(10)
    .default([REGION.currency]),
  fixedFee: z.number().int().min(0).default(0),
  percentageFee: z.number().min(0).max(100).default(0),
  /** Non-secret per-provider settings (InstaPay handle/phone/expiry, COD percentage). */
  settings: z.record(z.string(), z.unknown()).optional(),
});

// BE:S-3: the provider is the URL segment and NEVER updatable. With `provider` in the body a cod/instapay row could be renamed
// into an enabled paymob row, skipping the credentials/test/activation gate keyed on the URL provider. Zod strips the unknown
// key, so a UI that echoes the whole row still works and the rename is simply ignored.
const updateConfigSchema = paymentConfigSchema.omit({ provider: true }).partial();

// ==========================================
// Helper Functions
// ==========================================

/**
 * Display fingerprint for a credential: the last 4 characters of the
 * PLAINTEXT, taken at save time (#2010). Stored in its own column so no read
 * path ever has to decrypt to answer "which key is saved?".
 */
export function credentialFingerprint(plaintext: string): string {
  return plaintext.slice(-4);
}

/**
 * Masked view of a PaymentConfig's credentials. Never decrypts and never
 * returns any part of the stored ciphertext (#2010 — the old
 * `encryption.mask(<ciphertext>)` showed ciphertext fragments that identified
 * nothing). apiKey / merchantId show `****` + the save-time fingerprint; a row
 * saved before the fingerprint column existed shows `****` and sets the
 * `…FingerprintMissing` flag so the admin can say "re-save to show".
 */
export function maskCredentials(config: {
  apiKey?: string | null;
  secretKey?: string | null;
  merchantId?: string | null;
  webhookSecret?: string | null;
  apiKeyLast4?: string | null;
  merchantIdLast4?: string | null;
}) {
  const withFingerprint = (stored: string | null | undefined, last4: string | null | undefined) =>
    stored ? (last4 ? `****${last4}` : '****') : null;
  return {
    apiKey: withFingerprint(config.apiKey, config.apiKeyLast4),
    secretKey: config.secretKey ? '****' : null,
    merchantId: withFingerprint(config.merchantId, config.merchantIdLast4),
    webhookSecret: config.webhookSecret ? '****' : null,
    apiKeyFingerprintMissing: Boolean(config.apiKey) && !config.apiKeyLast4,
    merchantIdFingerprintMissing: Boolean(config.merchantId) && !config.merchantIdLast4,
  };
}

/**
 * Validate and normalise the NON-secret `settings` JSON of one provider config.
 * InstaPay needs a handle or a phone once it is enabled (a disabled draft may be
 * partial); COD takes an optional percentage. Anything else carries no settings.
 */
export function normalizeProviderSettings(
  provider: string,
  settings: Record<string, unknown> | undefined,
  isEnabled: boolean
): Record<string, unknown> {
  const raw = settings ?? {};
  if (provider === 'instapay') {
    const parsed = (isEnabled ? instapaySettingsSchema : instapaySettingsBaseSchema).safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        422,
        'INVALID_PAYMENT_SETTINGS',
        parsed.error.issues.map(i => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
      );
    }
    return parsed.data;
  }
  if (provider === 'cod') {
    const parsed = codSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(422, 'INVALID_PAYMENT_SETTINGS', 'percentBps must be 0-5000');
    }
    return parsed.data;
  }
  // The Egyptian gateways: only their mode-independent, NON-secret settings live here. Paymob's
  // public key and integration ids differ between sandbox and live, so they are credential fields
  // of the catalog (encrypted blob, per mode) and Paymob keeps nothing in this column.
  if (provider === 'paymob') return {};
  const gatewaySchema =
    provider === 'kashier'
      ? kashierSettingsSchema
      : provider === 'fawry'
        ? fawrySettingsSchema
        : null;
  if (gatewaySchema) {
    const parsed = gatewaySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        422,
        'INVALID_PAYMENT_SETTINGS',
        parsed.error.issues.map(i => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
      );
    }
    return parsed.data;
  }
  return {};
}

const LEGACY_CREDENTIAL_KEYS = ['apiKey', 'secretKey', 'merchantId', 'webhookSecret'] as const;

/**
 * Single writer for gateway credentials: on the STORE routes a non-manual provider's keys are
 * saved ONLY through `PUT /store/:storeId/:provider/credentials` (catalog fields, per mode, then
 * Test connection). The generic create/update routes refuse them instead of writing the legacy
 * columns, so there is one path that validates, encrypts, audits and invalidates the test.
 */
function refuseLegacyGatewayCredentials(provider: string, body: Record<string, unknown>): void {
  const entry = getProviderEntry(provider);
  if (!entry || entry.manual) return;
  const sent = LEGACY_CREDENTIAL_KEYS.filter(k => typeof body[k] === 'string' && body[k] !== '');
  if (sent.length > 0) {
    throw new AppError(
      422,
      'USE_CREDENTIALS_ENDPOINT',
      `Save ${provider} credentials with PUT /payment-settings/store/:storeId/${provider}/credentials`
    );
  }
}

function encryptCredentials(data: {
  apiKey?: string;
  secretKey?: string;
  merchantId?: string;
  webhookSecret?: string;
}) {
  return {
    apiKey: data.apiKey ? encryption.encrypt(data.apiKey) : undefined,
    apiKeyLast4: data.apiKey ? credentialFingerprint(data.apiKey) : undefined,
    secretKey: data.secretKey ? encryption.encrypt(data.secretKey) : undefined,
    merchantId: data.merchantId ? encryption.encrypt(data.merchantId) : undefined,
    merchantIdLast4: data.merchantId ? credentialFingerprint(data.merchantId) : undefined,
    webhookSecret: data.webhookSecret ? encryption.encrypt(data.webhookSecret) : undefined,
  };
}

// ==========================================
// Global (platform-level) payment settings: RETIRED (R-EBDA-007)
// ==========================================
// Under strict RLS (role ebda_app) payment_configs rows with store_id IS NULL
// are invisible and unwritable, and the tenant guard refuses an unscoped
// paymentConfig query, so the old global routes could only list nothing or
// fail. Payments are configured per store (/store/:storeId/...). Still behind
// authenticate + settings:read so an anonymous caller gets 401, not a hint.
router.use(
  (req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith('/store/') ? next() : authenticate(req, res, next),
  (req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith('/store/') ? next() : requirePermission('settings:read')(req, res, next),
  (req: Request, _res: Response, next: NextFunction) =>
    req.path.startsWith('/store/')
      ? next()
      : next(
          new AppError(
            410,
            'GLOBAL_PAYMENT_CONFIG_UNSUPPORTED',
            'Platform-level payment configuration is not supported; configure payments per store.'
          )
        )
);

// ==========================================
// Routes - Store-Specific Payment Settings (Store Admin)
// ==========================================

/**
 * GET /payment-settings/store/:storeId
 * Get store-specific payment configurations
 */
router.get(
  '/store/:storeId',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Defense-in-depth: inline ownership check (requireStoreAccess already
      // enforced this, but keep as belt-and-suspenders for explicitness)
      const user = getAuthUser(req);
      if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      // Get store-specific configs
      const storeConfigs = await (
        await storeDb(storeId)
      ).paymentConfig.findMany({
        where: { storeId },
        orderBy: { provider: 'asc' },
      });

      // Get global configs to show which are available

      // Mask sensitive credentials. `circuit` is the LIVE outage state of this
      // method on this node (open circuit = the checkout is hiding it right now);
      // `healthStatus` is the last persisted value.
      const safeStoreConfigs = storeConfigs.map(config => ({
        ...publicPaymentConfig(config, storeId),
        ...maskCredentials(config),
        circuit: providerHealth(storeId, config.provider),
      }));

      res.json({
        success: true,
        data: {
          storeConfigs: safeStoreConfigs,
          // No platform-level configs exist for the app role (R-EBDA-007); kept as an
          // empty list so the response shape does not change.
          globalConfigs: [],
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payment-settings/store/:storeId
 * Create store-specific payment configuration (override global)
 */
router.post(
  '/store/:storeId',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = paymentConfigSchema.parse(req.body);
      const user = getAuthUser(req);
      const userId = user.userId;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Defense-in-depth: inline ownership check (requireStoreAccess already enforced this)
      if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      // Check if provider already exists for this store
      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({
        where: {
          provider: data.provider,
          storeId,
        },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          error: { code: 'ALREADY_EXISTS', message: 'Provider already configured for this store' },
        });
        return;
      }

      // If setting as default, unset other defaults for this store
      if (data.isDefault) {
        await (
          await storeWriter(storeId)
        ).paymentConfig.updateMany({
          where: { storeId, isDefault: true },
          data: { isDefault: false },
        });
      }

      refuseLegacyGatewayCredentials(data.provider, req.body ?? {});
      // A gateway created enabled has no tested credentials yet: the gate refuses it.
      if (data.isEnabled) {
        assertEnableAllowed({
          provider: data.provider,
          testMode: data.testMode,
          isEnabled: true,
          credentials: null,
          connectionTest: null,
        });
      }

      // Encrypt credentials before storing
      const encryptedCreds = encryptCredentials(data);

      const config = await (
        await storeWriter(storeId)
      ).paymentConfig.create({
        data: {
          storeId,
          provider: data.provider,
          isEnabled: data.isEnabled,
          isDefault: data.isDefault,
          displayName: data.displayName,
          displayNameAr: data.displayNameAr,
          apiKey: encryptedCreds.apiKey,
          apiKeyLast4: encryptedCreds.apiKeyLast4,
          secretKey: encryptedCreds.secretKey,
          merchantId: encryptedCreds.merchantId,
          merchantIdLast4: encryptedCreds.merchantIdLast4,
          webhookSecret: encryptedCreds.webhookSecret,
          testMode: data.testMode,
          supportedMethods: data.supportedMethods,
          supportedCurrencies: data.supportedCurrencies,
          fixedFee: data.fixedFee,
          percentageFee: data.percentageFee,
          settings: normalizeProviderSettings(
            data.provider,
            data.settings,
            data.isEnabled
          ) as Prisma.InputJsonValue,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      await auditLog({
        action: 'store_payment_config.created',
        userId,
        resourceType: 'payment_config',
        resourceId: config.id,
        details: { storeId, provider: data.provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Clear provider cache for this store
      PaymentService.clearCache(storeId);

      res.status(201).json({
        success: true,
        data: {
          config: {
            ...publicPaymentConfig(config, config.storeId),
            ...maskCredentials(config),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /payment-settings/store/:storeId/:provider
 * Update store-specific payment configuration
 */
router.put(
  '/store/:storeId/:provider',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, provider } = req.params;
      const data = updateConfigSchema.parse(req.body);
      const user = getAuthUser(req);
      const userId = user.userId;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Defense-in-depth: inline ownership check (requireStoreAccess already enforced this)
      if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({
        where: {
          provider: provider,
          storeId,
        },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment provider not configured for this store' },
        });
        return;
      }

      // If setting as default, unset other defaults for this store
      if (data.isDefault) {
        await (
          await storeWriter(storeId)
        ).paymentConfig.updateMany({
          where: { storeId, isDefault: true, id: { not: existing.id } },
          data: { isDefault: false },
        });
      }

      // Only encrypt credentials if they're being updated
      const updateData: Record<string, unknown> = {
        ...data,
        updatedBy: userId,
      };

      if (data.apiKey && !data.apiKey.includes('****')) {
        updateData.apiKey = encryption.encrypt(data.apiKey);
        updateData.apiKeyLast4 = credentialFingerprint(data.apiKey);
      } else {
        delete updateData.apiKey;
      }

      if (data.secretKey && data.secretKey !== '****') {
        updateData.secretKey = encryption.encrypt(data.secretKey);
      } else {
        delete updateData.secretKey;
      }

      if (data.merchantId && !data.merchantId.includes('****')) {
        updateData.merchantId = encryption.encrypt(data.merchantId);
        updateData.merchantIdLast4 = credentialFingerprint(data.merchantId);
      } else {
        delete updateData.merchantId;
      }

      if (data.webhookSecret && data.webhookSecret !== '****') {
        updateData.webhookSecret = encryption.encrypt(data.webhookSecret);
      } else {
        delete updateData.webhookSecret;
      }

      refuseLegacyGatewayCredentials(provider, req.body ?? {});
      // The enable gate on the RESULTING state: enabling, or switching the mode of an enabled
      // gateway (the other mode's credentials were never tested), needs a current test.
      const resultingEnabled = data.isEnabled ?? existing.isEnabled;
      if (resultingEnabled) {
        assertEnableAllowed({
          provider,
          testMode: data.testMode ?? existing.testMode,
          isEnabled: true,
          credentials: existing.credentials,
          connectionTest: existing.connectionTest,
        });
      }

      if (data.settings !== undefined || data.isEnabled !== undefined) {
        updateData.settings = normalizeProviderSettings(
          provider,
          {
            ...((existing.settings as Record<string, unknown> | null) ?? {}),
            ...(data.settings ?? {}),
          },
          data.isEnabled ?? existing.isEnabled
        );
      }

      const config = await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: updateData,
      });

      await auditLog({
        action: 'store_payment_config.updated',
        userId,
        resourceType: 'payment_config',
        resourceId: config.id,
        details: { storeId, provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Clear provider cache for this store
      PaymentService.clearCache(storeId);

      res.json({
        success: true,
        data: {
          config: {
            ...publicPaymentConfig(config, config.storeId),
            ...maskCredentials(config),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /payment-settings/store/:storeId/:provider
 * Delete store-specific payment configuration (revert to global)
 */
router.delete(
  '/store/:storeId/:provider',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, provider } = req.params;
      const user = getAuthUser(req);
      const userId = user.userId;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Defense-in-depth: inline ownership check (requireStoreAccess already enforced this)
      if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({
        where: {
          provider: provider,
          storeId,
        },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment provider not configured for this store' },
        });
        return;
      }

      await (
        await storeWriter(storeId)
      ).paymentConfig.delete({
        where: { id: existing.id, storeId },
      });

      await auditLog({
        action: 'store_payment_config.deleted',
        userId,
        resourceType: 'payment_config',
        resourceId: existing.id,
        details: { storeId, provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Clear provider cache for this store
      PaymentService.clearCache(storeId);

      res.json({
        success: true,
        data: { message: 'Store payment configuration deleted, reverting to global settings' },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payment-settings/store/:storeId/:provider/toggle
 * Enable/disable store-specific payment provider
 */
router.post(
  '/store/:storeId/:provider/toggle',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, provider } = req.params;
      const { enabled } = req.body;
      const user = getAuthUser(req);
      const userId = user.userId;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Defense-in-depth: inline ownership check (requireStoreAccess already enforced this)
      if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({
        where: {
          provider: provider,
          storeId,
        },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment provider not configured for this store' },
        });
        return;
      }

      // Disabling is always allowed; enabling a gateway needs a verified provider and a
      // successful Test connection of the credentials stored now (PROVIDERS-2 + plan 4.2/5).
      if (enabled === true) {
        assertEnableAllowed(existing);
      } else if (enabled !== false) {
        throw new AppError(400, 'VALIDATION_ERROR', '`enabled` must be true or false');
      }

      const config = await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: {
          isEnabled: enabled,
          updatedBy: userId,
        },
      });

      await auditLog({
        action: enabled ? 'store_payment_config.enabled' : 'store_payment_config.disabled',
        userId,
        resourceType: 'payment_config',
        resourceId: config.id,
        details: { storeId, provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Clear provider cache for this store
      PaymentService.clearCache(storeId);

      res.json({
        success: true,
        data: {
          config: {
            ...publicPaymentConfig(config, config.storeId),
            ...maskCredentials(config),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Connect a provider (catalog, plan 4.2): credentials -> Test connection -> enable
// ==========================================

const credentialUpdateSchema = z.object({
  mode: z.enum(['sandbox', 'live']),
  fields: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.null()])),
  /** Optionally make this mode the ACTIVE one (switching disables an enabled gateway until re-tested). */
  activate: z.boolean().optional(),
});

/** Loads the store and repeats the inline ownership check the other store routes make. */
async function loadOwnedStore(req: Request, storeId: string) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, ownerId: true },
  });
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const user = getAuthUser(req);
  if (user.role !== 'super_admin' && store.ownerId !== user.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }
  return { store, user };
}

/**
 * PUT /payment-settings/store/:storeId/:provider/credentials
 * Save (write-only) credential fields for one mode. Creates the config row (disabled) when the
 * store has none. Changing the ACTIVE mode's credentials of an enabled gateway disables it: the
 * new keys have not been tested.
 */
router.put(
  '/store/:storeId/:provider/credentials',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, provider } = req.params;
      const body = credentialUpdateSchema.parse(req.body);
      const { user } = await loadOwnedStore(req, storeId);
      const entry = connectableEntry(provider);
      assertMayConfigure(provider, user.role);

      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({ where: { provider, storeId } });
      const update = applyCredentialUpdate(entry, existing, {
        mode: body.mode,
        fields: body.fields,
      });
      const nextTestMode = body.activate ? body.mode === 'sandbox' : (existing?.testMode ?? true);
      const modeSwitched = existing ? existing.testMode !== nextTestMode : false;
      const mustDisable =
        Boolean(existing?.isEnabled) && (update.activeModeChanged || modeSwitched);

      const data = {
        credentials: update.cipher,
        credentialHints: update.hints as Prisma.InputJsonValue,
        testMode: nextTestMode,
        ...(mustDisable ? { isEnabled: false } : {}),
        updatedBy: user.userId,
      };
      const config = existing
        ? await (
            await storeWriter(storeId)
          ).paymentConfig.update({ where: { id: existing.id, storeId }, data })
        : await (
            await storeWriter(storeId)
          ).paymentConfig.create({
            data: {
              ...data,
              storeId,
              provider,
              isEnabled: false,
              displayName: entry.name.en,
              displayNameAr: entry.name.ar,
              supportedMethods: [...entry.capabilities.methods],
              settings: normalizeProviderSettings(provider, {}, false) as Prisma.InputJsonValue,
              createdBy: user.userId,
            },
          });

      // Names of the fields that changed, never their values.
      await auditLog({
        action: 'store_payment_config.credentials_updated',
        storeId,
        userId: user.userId,
        resourceType: 'payment_config',
        resourceId: config.id,
        details: {
          storeId,
          provider,
          mode: body.mode,
          fields: update.changed,
          activated: Boolean(body.activate),
          disabledUntilRetested: mustDisable,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      // PROVIDERS-3: SANDBOX-FIRST automatic check of the credentials just saved (the saved
      // mode), with the provider's one read-only call. Never a charge. A failed check does not
      // undo the save: the merchant fixes the field and saves again.
      let finalConfig = config;
      let check: ConnectionCheckView | null = null;
      if (update.changed.length > 0) {
        const { result, stored } = await runConnectionTest(config, body.mode);
        // Only the ACTIVE mode's proof is stored (the enable gate reads it); checking the other
        // mode just reports, so it can neither void a live proof nor mark a live gateway down.
        if ((body.mode === 'sandbox') === config.testMode) {
          finalConfig = await (
            await storeWriter(storeId)
          ).paymentConfig.update({
            where: { id: config.id, storeId },
            data: {
              connectionTest: stored as unknown as Prisma.InputJsonValue,
              healthStatus: result.ok
                ? 'healthy'
                : result.code === 'unreachable'
                  ? 'degraded'
                  : 'down',
              lastHealthCheck: new Date(stored.at),
            },
          });
        }
        await auditLog({
          action: 'store_payment_config.connection_tested',
          storeId,
          userId: user.userId,
          resourceType: 'payment_config',
          resourceId: config.id,
          details: {
            storeId,
            provider,
            mode: stored.mode,
            ok: result.ok,
            code: result.code,
            auto: true,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        await reportConnectionCheck({ storeId, provider, mode: stored.mode, code: result.code });
        check = describeConnectionCheck(result);
      }
      PaymentService.clearCache(storeId);

      res.json({
        success: true,
        data: {
          config: { ...publicPaymentConfig(finalConfig, storeId), ...maskCredentials(finalConfig) },
          changed: update.changed,
          disabledUntilRetested: mustDisable,
          check,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payment-settings/store/:storeId/:provider/test
 * ONE harmless authenticated call to the gateway with the ACTIVE mode's stored credentials. Runs
 * under store scope (`paymentSettingsRouteContext`): no transaction is held across the call.
 */
router.post(
  '/store/:storeId/:provider/test',
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, provider } = req.params;
      const { user } = await loadOwnedStore(req, storeId);
      connectableEntry(provider);
      assertMayConfigure(provider, user.role);
      const existing = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({ where: { provider, storeId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Save the credentials before testing the connection');
      }
      const startedAt = Date.now();
      const { result, stored } = await runConnectionTest(existing);
      const latency = Date.now() - startedAt;
      await reportConnectionCheck({ storeId, provider, mode: stored.mode, code: result.code });

      await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: {
          connectionTest: stored as unknown as Prisma.InputJsonValue,
          healthStatus: result.ok ? 'healthy' : result.code === 'unreachable' ? 'degraded' : 'down',
          lastHealthCheck: new Date(stored.at),
          updatedBy: user.userId,
        },
      });
      await auditLog({
        action: 'store_payment_config.connection_tested',
        storeId,
        userId: user.userId,
        resourceType: 'payment_config',
        resourceId: existing.id,
        details: { storeId, provider, mode: stored.mode, ok: result.ok, code: result.code },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: {
          provider,
          mode: stored.mode,
          test: {
            ok: result.ok,
            code: result.code,
            message: result.message,
            details: result.details ?? {},
            latency,
          },
          check: describeConnectionCheck(result),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
