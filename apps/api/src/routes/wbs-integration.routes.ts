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
import { wbsBridgeService, WbsUnauthorizedError } from '../services/wbs-bridge.service';
import { config } from '../config';
import { buildTemplatesForStore } from '../lib/wa-templates/buildForStore';
import { resolveHeaderHandle } from '../lib/wa-templates/resolveHeaderHandle';
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
  // wbsEnabled: optional on first-connect PUT (only wbsApiKey may be sent)
  wbsEnabled: z.boolean().optional(),
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
  /** Phase 7 opt-in for store-logo HEADER images on templates. */
  wbsTemplateUseLogoHeader: z.boolean().optional(),
});

type WbsIntegrationInput = z.infer<typeof wbsIntegrationSchema>;
// Note: wbsEnabled is now optional — callers only need to send what they're changing

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
          name: true,
          wbsEnabled: true,
          wbsClientId: true,
          wbsApiKey: true,
          wbsTemplates: true,
          wbsTemplateUseLogoHeader: true,
          logo: true,
        },
      });

      if (!store) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      // If a key is configured, try to fetch live metadata from WBS in parallel.
      // Never block the GET if WBS is down — return connectedTenant: null + error.
      let connectedTenant: {
        businessName: string;
        phoneNumber: string | null;
        availableTemplates: Array<{
          name: string;
          language: string;
          status: string;
          category: string;
          variableCount: number;
        }>;
        keySetAt?: string | null;
      } | null = null;
      let connectedTenantError: string | null = null;

      if (store.wbsApiKey) {
        try {
          const plaintextKey = encryption.decrypt(store.wbsApiKey);
          const metadata = await wbsBridgeService.fetchMetadata(plaintextKey);
          connectedTenant = {
            businessName: metadata.businessName,
            phoneNumber: metadata.phoneNumber,
            availableTemplates: metadata.templates,
          };
        } catch (err) {
          // Silently absorb — WBS may be down or key was just revoked
          connectedTenantError =
            err instanceof WbsUnauthorizedError ? 'invalid_api_key' : 'wbs_unavailable';
          logger.warn(
            { storeId, err: (err as Error).message },
            '[WBS-INTEGRATION] Could not fetch metadata during GET'
          );
        }
      }

      // Augment with FWB's OWN approved templates. WBS metadata reflects
      // its templates table which can lag (Meta callbacks missed,
      // templates approved via Meta UI directly, etc.). FWB's
      // WhatsAppTemplate rows are the more authoritative "approved for
      // THIS store" set because the bridge updates them via
      // /wa-bridge/templates/status webhooks. Union + dedupe by
      // name+language. If FWB has own-approved rows we also clear the
      // wbs_unavailable error since the connection is functionally
      // healthy (the merchant still has approved templates to choose).
      const ownApproved = await prisma.whatsAppTemplate.findMany({
        where: { storeId, status: 'approved' },
        select: { metaName: true, language: true, category: true },
      });
      if (ownApproved.length > 0) {
        const tenantNow = connectedTenant ?? {
          businessName: store.name,
          phoneNumber: null,
          availableTemplates: [],
        };
        const seen = new Set(tenantNow.availableTemplates.map(t => `${t.name}:::${t.language}`));
        const merged = [...tenantNow.availableTemplates];
        for (const t of ownApproved) {
          const key = `${t.metaName}:::${t.language}`;
          if (seen.has(key)) continue;
          merged.push({
            name: t.metaName,
            language: t.language,
            status: 'APPROVED',
            category: t.category || 'UTILITY',
            variableCount: 0,
          });
          seen.add(key);
        }
        connectedTenant = { ...tenantNow, availableTemplates: merged };
        if (connectedTenantError === 'wbs_unavailable') connectedTenantError = null;
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
          wbsTemplateUseLogoHeader: store.wbsTemplateUseLogoHeader,
          storeHasLogo: Boolean(store.logo),
          connectedTenant,
          ...(connectedTenantError ? { connectedTenantError } : {}),
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

      // ── Determine PUT intent ────────────────────────────────────────────────
      //
      // Three distinct intents based on what the client sends:
      //   A) wbsApiKey is a real new key (not masked, not null) → first-connect or rotate
      //   B) wbsTemplates only → template picks, no metadata call
      //   C) wbsEnabled = false → disable, no validation
      //   D) wbsEnabled = true + no key in DB → error: must connect first

      const isNewApiKey =
        input.wbsApiKey !== undefined &&
        input.wbsApiKey !== null &&
        input.wbsApiKey !== '' &&
        !input.wbsApiKey.includes('****');

      const isClearApiKey = input.wbsApiKey === null || input.wbsApiKey === '';

      // Load current store to check key state
      const currentStore = await prisma.store.findUnique({
        where: { id: storeId },
        select: { wbsApiKey: true, wbsEnabled: true },
      });

      if (!currentStore) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      // Rule: cannot enable when no key is set
      if (input.wbsEnabled === true && !currentStore.wbsApiKey && !isNewApiKey) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MUST_CONNECT_KEY_FIRST',
            message: 'Connect a WBS API key before enabling WhatsApp notifications',
          },
        });
        return;
      }

      // ── A) First-connect or key rotation — validate via metadata ───────────
      let autoPopulatedClientId: string | undefined;

      if (isNewApiKey && input.wbsApiKey) {
        try {
          const metadata = await wbsBridgeService.fetchMetadata(input.wbsApiKey);
          // Auto-populate clientId from metadata
          autoPopulatedClientId = metadata.clientId;
          logger.info(
            { storeId, clientId: metadata.clientId, businessName: metadata.businessName },
            '[WBS-INTEGRATION] Key validated via metadata — clientId auto-populated'
          );
        } catch (err) {
          if (err instanceof WbsUnauthorizedError) {
            res.status(400).json({
              success: false,
              error: {
                code: 'INVALID_API_KEY',
                message: 'The API key was rejected by Force WhatsApp Business Platform',
              },
            });
            return;
          }
          // WBS server error — allow the key to be saved anyway (merchant can retry)
          logger.warn(
            { storeId, err: (err as Error).message },
            '[WBS-INTEGRATION] WBS unavailable during key validation — saving key anyway'
          );
        }
      }

      // ── Build update data ───────────────────────────────────────────────────

      const updateData: Record<string, unknown> = {};

      if (input.wbsEnabled !== undefined) {
        updateData.wbsEnabled = input.wbsEnabled;
      }

      // Auto-populated clientId from metadata takes precedence over any manual value
      if (autoPopulatedClientId) {
        updateData.wbsClientId = autoPopulatedClientId;
      } else if (input.wbsClientId !== undefined) {
        updateData.wbsClientId = input.wbsClientId || null;
      }

      if (input.wbsTemplates !== undefined) {
        updateData.wbsTemplates = input.wbsTemplates;
      }

      if (input.wbsTemplateUseLogoHeader !== undefined) {
        updateData.wbsTemplateUseLogoHeader = input.wbsTemplateUseLogoHeader;
      }

      // API key handling
      if (isNewApiKey && input.wbsApiKey) {
        updateData.wbsApiKey = encryption.encrypt(input.wbsApiKey);
        logger.info({ storeId }, '[WBS-INTEGRATION] API key updated');
      } else if (isClearApiKey) {
        updateData.wbsApiKey = null;
        updateData.wbsClientId = null;
        updateData.wbsEnabled = false;
        logger.info({ storeId }, '[WBS-INTEGRATION] API key cleared — integration disabled');
      }
      // else: masked value or undefined → no key change

      if (input.wbsEnabled === false) {
        logger.info({ storeId }, '[WBS-INTEGRATION] WBS integration disabled by admin');
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: updateData,
        select: {
          slug: true,
          name: true,
          nameAr: true,
          logo: true,
          wbsEnabled: true,
          wbsClientId: true,
          wbsApiKey: true,
          wbsTemplates: true,
          wbsTemplateUseLogoHeader: true,
        },
      });

      // ── Phase 7 atomic Connect+Generate ───────────────────────────────────
      // On first-connect (new API key just validated above), seed the
      // per-store WhatsAppTemplate rows AND submit them to Meta in one shot.
      // Existing rows aren't touched (skipDuplicates). Errors here don't
      // fail the save — the merchant can retry generation manually via the
      // wa-templates page if either step trips.
      let templatesAutoSeeded: number | undefined;
      let templatesAutoSubmitted: number | undefined;
      let templatesAutoError: string | undefined;
      if (isNewApiKey && input.wbsApiKey) {
        try {
          // Phase 7 opt-in: when wbsTemplateUseLogoHeader is true, upload
          // the store logo to Meta + get a header_handle. Skipped silently
          // when the merchant hasn't opted in or has no logo set.
          const headerHandle = await resolveHeaderHandle({
            wbsApiKey: input.wbsApiKey,
            logoUrl: updated.logo,
            optedIn: updated.wbsTemplateUseLogoHeader,
            wbsBaseUrl: config.wbsBaseUrl,
          });
          const built = buildTemplatesForStore({
            slug: updated.slug,
            name: updated.name,
            nameAr: updated.nameAr,
            headerHandle,
          });

          const existing = await prisma.whatsAppTemplate.findMany({
            where: { storeId },
            select: { sourceKey: true, language: true },
          });
          const have = new Set(existing.map(r => `${r.sourceKey}:${r.language}`));
          const toCreate = built.filter(t => !have.has(`${t.sourceKey}:${t.language}`));

          if (toCreate.length > 0) {
            await prisma.whatsAppTemplate.createMany({
              data: toCreate.map(t => {
                const bodyComp = t.components.find(c => c.type === 'BODY');
                return {
                  storeId,
                  sourceKey: t.sourceKey,
                  language: t.language,
                  metaName: t.name,
                  category: t.category,
                  body: bodyComp?.text || '',
                  status: 'draft',
                };
              }),
              skipDuplicates: true,
            });
            templatesAutoSeeded = toCreate.length;
          } else {
            templatesAutoSeeded = 0;
          }

          // Submit all drafts (including any pre-existing ones from a partial
          // earlier attempt) to WBS → Meta.
          const drafts = await prisma.whatsAppTemplate.findMany({
            where: { storeId, status: 'draft' },
          });
          if (drafts.length > 0) {
            const definitions = drafts
              .map(row => {
                const tmpl = built.find(
                  t => t.sourceKey === row.sourceKey && t.language === row.language
                );
                if (!tmpl) return null;
                return {
                  sourceKey: row.sourceKey,
                  name: tmpl.name,
                  language: tmpl.metaLanguage,
                  category: tmpl.category,
                  components: tmpl.components,
                };
              })
              .filter(Boolean);

            const submitResp = await fetch(
              `${config.wbsBaseUrl}/api/v1/external/templates/submit`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-wbs-api-key': input.wbsApiKey,
                },
                body: JSON.stringify({ fwbStoreId: storeId, definitions }),
                signal: AbortSignal.timeout(30_000),
              }
            );
            const submitBody = (await submitResp.json().catch(() => ({}))) as {
              success?: boolean;
              results?: Array<{
                sourceKey: string;
                name: string;
                language: string;
                status: string;
                metaTemplateId?: string | null;
                error?: string;
              }>;
            };
            if (submitResp.ok && submitBody.success && Array.isArray(submitBody.results)) {
              let submittedOk = 0;
              for (const r of submitBody.results) {
                await prisma.whatsAppTemplate.updateMany({
                  where: { storeId, sourceKey: r.sourceKey, language: r.language },
                  data: {
                    status: r.status === 'pending' ? 'pending' : r.status,
                    metaTemplateId: r.metaTemplateId || undefined,
                    rejectionReason: r.error || null,
                    lastSyncedAt: new Date(),
                  },
                });
                if (r.status === 'pending') submittedOk += 1;
              }
              templatesAutoSubmitted = submittedOk;
            } else {
              templatesAutoError = 'WBS rejected the batch submit';
            }
          } else {
            templatesAutoSubmitted = 0;
          }
        } catch (err) {
          templatesAutoError = (err as Error).message;
          logger.warn(
            { storeId, err: templatesAutoError },
            '[WBS-INTEGRATION] auto generate+submit failed (save still succeeded)'
          );
        }
      }

      await auditLog({
        action: 'store.wbs_integration_updated',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: {
          wbsEnabled: input.wbsEnabled ?? null,
          wbsClientId: autoPopulatedClientId || input.wbsClientId || null,
          apiKeyChanged: isNewApiKey,
          keyCleared: isClearApiKey,
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
          // Phase 7 atomic: surface what happened to the auto-generated
          // templates so the UI can show "Connected + 12 templates pending"
          ...(templatesAutoSeeded !== undefined && {
            templatesAutoSeeded,
            templatesAutoSubmitted,
            templatesAutoError,
          }),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
