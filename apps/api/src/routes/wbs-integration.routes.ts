/**
 * WBS Integration Routes — Force Store ↔ WBS Bridge Admin API
 *
 * Allows store admins to configure their Force WhatsApp Business Platform
 * integration: enable/disable, set client ID, API key (stored encrypted),
 * and per-event template names.
 *
 * Routes:
 *   GET  /stores/:id/integrations/wbs  — fetch current config (key masked)
 *   PUT  /stores/:id/integrations/wbs  — update config
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate } from '../middleware/auth';
import { authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { encryption } from '../services/encryption.service';
import { auditLog } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// ─── Validation ──────────────────────────────────────────────────────────────

const templateEntrySchema = z.object({
  name: z.string().min(1, 'Template name is required'),
  languageCode: z.string().default('en'),
});

const wbsIntegrationSchema = z.object({
  wbsEnabled: z.boolean().default(false),
  wbsClientId: z.string().nullable().optional(),
  // API key: empty string means "no change"; null means "clear"; any other value = new key
  wbsApiKey: z.string().nullable().optional(),
  wbsTemplates: z
    .object({
      orderPaid: templateEntrySchema.optional(),
      orderShipped: templateEntrySchema.optional(),
      orderDelivered: templateEntrySchema.optional(),
    })
    .nullable()
    .optional(),
});

type WbsIntegrationInput = z.infer<typeof wbsIntegrationSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mask the API key for safe display: show last 4 chars only.
 * Returns '****' when key is null/empty.
 */
function maskApiKey(encryptedKey: string | null | undefined): string {
  if (!encryptedKey) return '';
  try {
    // Decrypt to mask (we only show the suffix, never the plaintext)
    const plain = encryption.decrypt(encryptedKey);
    return encryption.mask(plain, 4);
  } catch {
    return '****';
  }
}

// ─── GET /stores/:id/integrations/wbs ────────────────────────────────────────

router.get(
  '/:id/integrations/wbs',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          wbsEnabled: true,
          wbsClientId: true,
          wbsApiKey: true,
          wbsTemplates: true,
        },
      });

      if (!store) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      res.json({
        success: true,
        data: {
          wbsEnabled: store.wbsEnabled,
          wbsClientId: store.wbsClientId,
          // Never return the raw/decrypted key — return masked version only
          wbsApiKeyMasked: maskApiKey(store.wbsApiKey),
          hasApiKey: Boolean(store.wbsApiKey),
          wbsTemplates: store.wbsTemplates,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /stores/:id/integrations/wbs ────────────────────────────────────────

router.put(
  '/:id/integrations/wbs',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;

      const parsed = wbsIntegrationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: { code: 'VALIDATION_FAILED', details: parsed.error.flatten() },
        });
        return;
      }

      const input: WbsIntegrationInput = parsed.data;

      // Build update data
      const updateData: Record<string, unknown> = {
        wbsEnabled: input.wbsEnabled,
      };

      if (input.wbsClientId !== undefined) {
        updateData.wbsClientId = input.wbsClientId || null;
      }

      if (input.wbsTemplates !== undefined) {
        updateData.wbsTemplates = input.wbsTemplates;
      }

      // API key handling:
      //   - null / empty string  → clear the key (disable integration)
      //   - non-empty string that looks like a masked key (contains '****') → no change
      //   - any other non-empty string → encrypt and store
      if (input.wbsApiKey !== undefined) {
        if (!input.wbsApiKey || input.wbsApiKey === null) {
          updateData.wbsApiKey = null;
        } else if (!input.wbsApiKey.includes('****')) {
          // New key — encrypt it
          updateData.wbsApiKey = encryption.encrypt(input.wbsApiKey);
          logger.info({ storeId }, '[WBS-INTEGRATION] API key updated');
        }
        // else: masked value passed back → no change
      }

      // If disabling the integration, reset the failure counter indirectly
      // by updating wbsEnabled = false (the auto-disable path sets this too)
      if (input.wbsEnabled === false) {
        logger.info({ storeId }, '[WBS-INTEGRATION] WBS integration disabled by admin');
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: updateData,
        select: {
          wbsEnabled: true,
          wbsClientId: true,
          wbsApiKey: true,
          wbsTemplates: true,
        },
      });

      await auditLog({
        action: 'store.wbs_integration_updated',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: {
          wbsEnabled: input.wbsEnabled,
          wbsClientId: input.wbsClientId ?? null,
          apiKeyChanged: input.wbsApiKey !== undefined && !input.wbsApiKey?.includes('****'),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: {
          wbsEnabled: updated.wbsEnabled,
          wbsClientId: updated.wbsClientId,
          wbsApiKeyMasked: maskApiKey(updated.wbsApiKey),
          hasApiKey: Boolean(updated.wbsApiKey),
          wbsTemplates: updated.wbsTemplates,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
