import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, Prisma, PaymentProvider } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { encryption } from '../services/encryption.service';
import { auditLog } from '../middleware/security';
import { PaymentService } from '../services/payment.service';
import { getAuthUser } from '../utils/store-helpers';
import { tenantContext } from '../middleware/tenant-context';

import {
  REGION,
  codSettingsSchema,
  fawrySettingsSchema,
  instapaySettingsBaseSchema,
  instapaySettingsSchema,
  kashierSettingsSchema,
  paymobSettingsBaseSchema,
  paymobSettingsSchema,
} from '@force/shared';
import { AppError } from '../middleware/error-handler';
import { providerHealth } from '../services/payment-providers/provider-health';
const router = Router();

// Mounted bare at '/payment-settings' in routes/index.ts. Every '/store/:storeId/...' route below sets RLS tenant context
// once Express resolves :storeId, matching coupon.routes.ts /
// shipping.routes.ts. Closes the one F2-GAP router with zero DB backstop
// over PaymentConfig (encrypted provider secrets) — see
// docs/audits/2026-07-16-rls-cutover-readiness-map.md §2/§6#3. Confirmed no
// external I/O in these handlers (no fetch/3rd-party calls).
router.param('storeId', tenantContext);

// ==========================================
// Validation Schemas
// ==========================================

const paymentConfigSchema = z.object({
  provider: z.enum(['cod', 'instapay', 'paymob', 'kashier', 'fawry']),
  isEnabled: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  displayName: z.string().optional(),
  displayNameAr: z.string().optional(),
  apiKey: z.string().optional(),
  secretKey: z.string().optional(),
  merchantId: z.string().optional(),
  webhookSecret: z.string().optional(),
  testMode: z.boolean().default(true),
  supportedMethods: z.array(z.string()).default([]),
  supportedCurrencies: z.array(z.string()).default([REGION.currency]),
  fixedFee: z.number().int().min(0).default(0),
  percentageFee: z.number().min(0).max(100).default(0),
  /** Non-secret per-provider settings (InstaPay handle/phone/expiry, COD percentage). */
  settings: z.record(z.string(), z.unknown()).optional(),
});

const updateConfigSchema = paymentConfigSchema.partial();

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
  // The Egyptian gateways: only their NON-secret settings live here (the keys are in the
  // encrypted columns). An enabled Paymob needs its public key and an integration id.
  const gatewaySchema =
    provider === 'paymob'
      ? isEnabled
        ? paymobSettingsSchema
        : paymobSettingsBaseSchema
      : provider === 'kashier'
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

/**
 * The credentials an enabled gateway cannot work without, by provider. An enabled gateway with a
 * missing key would be offered at checkout and fail for every customer, so enabling is refused
 * until they are all saved (a saved credential counts: the form leaves it blank to keep it).
 */
const REQUIRED_CREDENTIALS: Record<string, Array<keyof CredentialPresence>> = {
  paymob: ['apiKey', 'webhookSecret'],
  kashier: ['merchantId', 'apiKey', 'secretKey'],
  fawry: ['merchantId', 'apiKey'],
};
interface CredentialPresence {
  apiKey: boolean;
  secretKey: boolean;
  merchantId: boolean;
  webhookSecret: boolean;
}
const CREDENTIAL_LABEL: Record<string, string> = {
  apiKey: 'API / secret key',
  secretKey: 'secret key',
  merchantId: 'merchant ID',
  webhookSecret: 'HMAC / webhook secret',
};

export function assertGatewayCredentials(
  provider: string,
  isEnabled: boolean,
  saved: Partial<Record<keyof CredentialPresence, string | null | undefined>>,
  incoming: Partial<Record<keyof CredentialPresence, string | null | undefined>>
): void {
  const required = REQUIRED_CREDENTIALS[provider];
  if (!isEnabled || !required) return;
  const missing = required.filter(
    k => !(saved[k] || (incoming[k] && !incoming[k]!.includes('****')))
  );
  if (missing.length > 0) {
    throw new AppError(
      422,
      'INVALID_PAYMENT_SETTINGS',
      `Cannot enable ${provider}: missing ${missing.map(k => CREDENTIAL_LABEL[k]).join(', ')}`
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
// Platform-level (global) payment settings: RETIRED (R-EBDA-007)
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // Verify user has access to this store
      const store = await prisma.store.findUnique({
        where: { id: storeId },
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
      const storeConfigs = await prisma.paymentConfig.findMany({
        where: { storeId },
        orderBy: { provider: 'asc' },
      });

      // Mask sensitive credentials. `circuit` is the LIVE outage state of this
      // method on this node (open circuit = the checkout is hiding it right now);
      // `healthStatus` is the last persisted value.
      const safeStoreConfigs = storeConfigs.map(config => ({
        ...config,
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
      const existing = await prisma.paymentConfig.findFirst({
        where: {
          provider: data.provider as PaymentProvider,
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
        await prisma.paymentConfig.updateMany({
          where: { storeId, isDefault: true },
          data: { isDefault: false },
        });
      }

      assertGatewayCredentials(data.provider, data.isEnabled, {}, data);

      // Encrypt credentials before storing
      const encryptedCreds = encryptCredentials(data);

      const config = await prisma.paymentConfig.create({
        data: {
          storeId,
          provider: data.provider as PaymentProvider,
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
            ...config,
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

      const existing = await prisma.paymentConfig.findFirst({
        where: {
          provider: provider as PaymentProvider,
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
        await prisma.paymentConfig.updateMany({
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

      assertGatewayCredentials(provider, data.isEnabled ?? existing.isEnabled, existing, data);

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

      const config = await prisma.paymentConfig.update({
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
            ...config,
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

      const existing = await prisma.paymentConfig.findFirst({
        where: {
          provider: provider as PaymentProvider,
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

      await prisma.paymentConfig.delete({
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

      const existing = await prisma.paymentConfig.findFirst({
        where: {
          provider: provider as PaymentProvider,
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

      const config = await prisma.paymentConfig.update({
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
            ...config,
            ...maskCredentials(config),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
