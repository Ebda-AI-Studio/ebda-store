/**
 * WBS Integration Routes — Force AI Store ↔ WBS Bridge Admin API
 *
 * Allows store admins to configure their Force AI WhatsApp Business Platform
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
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { encryption } from '../services/encryption.service';
import { wbsBridgeService, WbsUnauthorizedError } from '../services/wbs-bridge.service';
import {
  provisionCatalog,
  isProvisioningConfigured,
  MetaProvisionerError,
} from '../services/meta-provisioner.service';
import { config } from '../config';
import { buildTemplatesForStore } from '../lib/wa-templates/buildForStore';
import { resolveHeaderHandle } from '../lib/wa-templates/resolveHeaderHandle';
import { auditLog } from '../middleware/security';
import { requireFeature } from '../middleware/feature-gate';
import { getAuthUser } from '../utils/store-helpers';
import { sendAlert } from '../services/alerts.service';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// ─── Validation ──────────────────────────────────────────────────────────────

const templateEntrySchema = z.object({
  name: z.string().min(1, 'Template name is required'),
  languageCode: z.string().default('en'),
});

const templateEntryWithChannelsSchema = templateEntrySchema.extend({
  /** Per-event channel toggles. Absent = both on (backward-compatible). */
  channels: z
    .object({
      whatsapp: z.boolean().default(true),
      email: z.boolean().default(true),
    })
    .optional(),
});

const botServiceMenuSchema = z.object({
  orderNow: z.boolean(),
  subscriptionBoxes: z.boolean(),
  locationsHours: z.boolean(),
  chatWithAgent: z.boolean(),
  labels: z
    .object({
      en: z.record(z.string()).optional(),
      ar: z.record(z.string()).optional(),
    })
    .optional(),
});

const wbsIntegrationSchema = z.object({
  // wbsEnabled: optional on first-connect PUT (only wbsApiKey may be sent)
  wbsEnabled: z.boolean().optional(),
  wbsClientId: z.string().nullable().optional(),
  // API key: empty string means "no change"; null means "clear"; any other value = new key
  wbsApiKey: z.string().nullable().optional(),
  wbsTemplates: z
    .object({
      orderPaid: templateEntryWithChannelsSchema.optional(),
      orderShipped: templateEntryWithChannelsSchema.optional(),
      orderDelivered: templateEntryWithChannelsSchema.optional(),
      cartAbandoned: templateEntryWithChannelsSchema.optional(),
    })
    .nullable()
    .optional(),
  /** Phase 7 opt-in for store-logo HEADER images on templates. */
  wbsTemplateUseLogoHeader: z.boolean().optional(),
  /**
   * Customer-DM ordering via WhatsApp — when set, FWB stores the value and
   * syncs it to WBS via PUT /api/v1/external/wa-ordering.
   * Default OFF (false) — merchant opts in explicitly from the Connection tab.
   */
  waCustomerOrderingEnabled: z.boolean().optional(),
  /**
   * Phase 2 bot intelligence: per-store bot copy overrides.
   * Shape: Record<string, { en?: string; ar?: string }> — keys match
   * botCopyDefaults.js in WBS. Absent keys fall back to canonical defaults.
   * null = clear all overrides (revert to defaults).
   */
  botCopy: z
    .record(z.object({ en: z.string().optional(), ar: z.string().optional() }))
    .nullable()
    .optional(),
  /**
   * Phase D — bot mode for native catalog support.
   * 'legacy_chat' (default) | 'native_catalog' | 'native_catalog_with_gemini_agent'
   */
  botMode: z.enum(['legacy_chat', 'native_catalog', 'native_catalog_with_gemini_agent']).optional(),
  /** Phase D — which services appear in the WhatsApp bot service menu. */
  botServiceMenu: botServiceMenuSchema.nullable().optional(),
  /** Phase D — Meta Commerce catalog ID (from Meta Business Manager). */
  metaCatalogId: z.string().min(1).nullable().optional(),
  /** Phase D — Meta Business Account ID. */
  metaBusinessId: z.string().min(1).nullable().optional(),
  /**
   * Phase D — Meta System User access token. Write-only from the admin.
   * NEVER returned to the client — stored encrypted at rest.
   * Undefined means "no change"; null means "clear token".
   */
  metaAccessToken: z.string().min(1).nullable().optional(),
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
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
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
          waCustomerOrderingEnabled: true,
          botCopy: true,
          logo: true,
          // Phase D — bot config
          botMode: true,
          botServiceMenu: true,
          metaCatalogId: true,
          metaBusinessId: true,
          metaAccessToken: true, // only used to derive hasToken — never returned plain
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
      // wbsLiveVerified is true ONLY when fetchMetadata() actually succeeded —
      // it is NOT set by the local-template fallback below. The settings card
      // uses this to show "Connected" vs "Saved · not verified": a store that
      // has local approved templates but whose WBS key is revoked/unreachable
      // must NOT show green "Connected".
      let wbsLiveVerified = false;

      if (store.wbsApiKey) {
        try {
          const plaintextKey = encryption.decrypt(store.wbsApiKey);
          const metadata = await wbsBridgeService.fetchMetadata(plaintextKey);
          connectedTenant = {
            businessName: metadata.businessName,
            phoneNumber: metadata.phoneNumber,
            availableTemplates: metadata.templates,
          };
          wbsLiveVerified = true;
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
      // healthy (the merchant still has approved templates to choose.
      //
      // NOTE: this augmentation populates connectedTenant from local DB data
      // even when the live WBS call failed. That is intentional for the
      // ConnectionTab's template-list display — but it must NOT be used to
      // infer "the WBS connection is live". Use wbsLiveVerified for that.
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
          waCustomerOrderingEnabled: store.waCustomerOrderingEnabled,
          botCopy: store.botCopy ?? null,
          storeHasLogo: Boolean(store.logo),
          // Phase D — bot config (never return metaAccessToken plain)
          botMode: store.botMode ?? 'legacy_chat',
          botServiceMenu: store.botServiceMenu ?? null,
          metaCatalogId: store.metaCatalogId ?? null,
          metaBusinessId: store.metaBusinessId ?? null,
          hasMetaToken: Boolean(store.metaAccessToken),
          // wbsLiveVerified: true ONLY when fetchMetadata() succeeded this request.
          // connectedTenant may be non-null even when false (local-template fallback).
          // The settings card MUST use this field — not connectedTenant — to determine
          // whether to show the green "Connected" chip.
          wbsLiveVerified,
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
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
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
                message: 'The API key was rejected by Force AI WhatsApp Business Platform',
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

      if (input.waCustomerOrderingEnabled !== undefined) {
        updateData.waCustomerOrderingEnabled = input.waCustomerOrderingEnabled;
      }

      // botCopy: null = clear overrides (revert to WBS canonical defaults);
      // object = merge/replace the whole overrides map. Partial key updates
      // are handled client-side (admin loads current, edits, saves whole map).
      if (input.botCopy !== undefined) {
        updateData.botCopy = input.botCopy;
      }

      // Phase D — bot mode + service menu + meta catalog config
      if (input.botMode !== undefined) {
        updateData.botMode = input.botMode;
      }
      if (input.botServiceMenu !== undefined) {
        updateData.botServiceMenu = input.botServiceMenu;
      }
      if (input.metaCatalogId !== undefined) {
        updateData.metaCatalogId = input.metaCatalogId;
      }
      if (input.metaBusinessId !== undefined) {
        updateData.metaBusinessId = input.metaBusinessId;
      }
      if (input.metaAccessToken !== undefined) {
        // null = clear token; any other value = encrypt and store
        updateData.metaAccessToken =
          input.metaAccessToken === null ? null : encryption.encrypt(input.metaAccessToken);
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

      // Capture previous botMode to detect transitions for Telegram alert.
      const prevStore =
        input.botMode !== undefined
          ? await prisma.store.findUnique({
              where: { id: storeId },
              select: { botMode: true, name: true, slug: true },
            })
          : null;

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
          waCustomerOrderingEnabled: true,
          botCopy: true,
          // Phase D
          botMode: true,
          botServiceMenu: true,
          metaCatalogId: true,
          metaBusinessId: true,
          metaAccessToken: true, // used to derive hasMetaToken only
        },
      });

      // Phase E.2 — Telegram alert on bot_mode transition to native_catalog
      // variants. Lets Ahmad see in-channel when a merchant flips to native
      // catalog mode (manual cutover for the first few merchants until the
      // flow is verified at scale). Fire-and-forget; doesn't block the save.
      if (
        prevStore &&
        input.botMode !== undefined &&
        prevStore.botMode !== input.botMode &&
        (input.botMode === 'native_catalog' || input.botMode === 'native_catalog_with_gemini_agent')
      ) {
        void sendAlert({
          level: 'info',
          scope: 'store',
          store: { id: storeId, name: prevStore.name, slug: prevStore.slug },
          source: 'fwb.wbs-integration.botMode',
          title: `Store flipped to ${input.botMode}`,
          body: `Bot mode changed from ${prevStore.botMode ?? 'unset'} to ${input.botMode}. Verify Meta Commerce catalog is approved + access token still valid.`,
          context: { prevBotMode: prevStore.botMode, newBotMode: input.botMode },
        }).catch(err => {
          logger.warn({ err, storeId }, '[WBS-INTEGRATION] botMode alert send failed');
        });
      }

      // ── Sync waCustomerOrderingEnabled to WBS ─────────────────────────────
      // Non-blocking: any error here MUST NOT fail the save — the FWB Store
      // record is the source of truth; WBS sync is best-effort and can be
      // retried by the next save. Log the error for observability.
      if (input.waCustomerOrderingEnabled !== undefined && updated.wbsApiKey) {
        (async () => {
          try {
            const plaintextKey = encryption.decrypt(updated.wbsApiKey!);
            await wbsBridgeService.syncWaOrdering(plaintextKey, updated.waCustomerOrderingEnabled);
            logger.info(
              { storeId, waCustomerOrderingEnabled: updated.waCustomerOrderingEnabled },
              '[WBS-INTEGRATION] wa_ordering_enabled synced to WBS'
            );
          } catch (err) {
            logger.warn(
              { storeId, err: (err as Error).message },
              '[WBS-INTEGRATION] waCustomerOrderingEnabled sync to WBS failed (store saved; WBS will be out-of-sync until next save)'
            );
          }
        })();
      }

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
          waCustomerOrderingEnabled: updated.waCustomerOrderingEnabled,
          botCopy: updated.botCopy ?? null,
          // Phase D
          botMode: updated.botMode ?? 'legacy_chat',
          botServiceMenu: updated.botServiceMenu ?? null,
          metaCatalogId: updated.metaCatalogId ?? null,
          metaBusinessId: updated.metaBusinessId ?? null,
          hasMetaToken: Boolean(updated.metaAccessToken),
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

// ─── POST /stores/:id/integrations/wbs/provision-meta-catalog ───────────────
//
// Super-admin only. Calls Meta Graph API to auto-create a Commerce Catalog
// under the Force AI parent Business Manager, assigns the system user, then
// persists the catalog id + BM id + encrypted access token onto the Store row
// — so the merchant doesn't have to navigate Meta Business Manager themselves.
//
// Refuses if:
//   - the Force AI master credentials aren't configured (env vars missing)
//   - the store already has a metaCatalogId (rotation goes through PUT)
//
// On success returns { metaCatalogId, metaBusinessId, hasMetaToken }.

router.post(
  '/:id/integrations/wbs/provision-meta-catalog',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const user = getAuthUser(req);

      if (!isProvisioningConfigured()) {
        res.status(503).json({
          success: false,
          error: {
            code: 'PROVISIONER_NOT_CONFIGURED',
            message:
              'Meta auto-provisioning is not configured. Set FORCE_AI_META_BM_ID + ' +
              'FORCE_AI_META_ADMIN_TOKEN on Railway (one-time Force AI setup).',
          },
        });
        return;
      }

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          metaCatalogId: true,
        },
      });

      if (!store) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      if (store.metaCatalogId) {
        res.status(409).json({
          success: false,
          error: {
            code: 'CATALOG_ALREADY_PROVISIONED',
            message:
              'This store already has a Meta catalog id. Clear it from the form before re-provisioning.',
          },
        });
        return;
      }

      // Catalog name shown to customers in WhatsApp UI — prefer the brand name.
      const catalogName = store.name || store.slug;

      let result;
      try {
        result = await provisionCatalog({ storeId, catalogName });
      } catch (err) {
        if (err instanceof MetaProvisionerError) {
          logger.error(
            { storeId, stage: err.stage, metaError: err.metaError },
            '[WBS-INTEGRATION] Meta auto-provisioning failed'
          );
          res.status(502).json({
            success: false,
            error: {
              code: 'META_PROVISIONING_FAILED',
              message: err.message,
              stage: err.stage,
            },
          });
          return;
        }
        throw err;
      }

      // Persist (token is encrypted at rest — matches the PUT path)
      const updated = await prisma.store.update({
        where: { id: storeId },
        data: {
          metaCatalogId: result.catalogId,
          metaBusinessId: result.businessId,
          metaAccessToken: encryption.encrypt(result.accessToken),
        },
        select: {
          slug: true,
          name: true,
          metaCatalogId: true,
          metaBusinessId: true,
          metaAccessToken: true,
        },
      });

      await auditLog({
        action: 'store.meta_catalog_provisioned',
        userId: user.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: {
          catalogId: result.catalogId,
          businessId: result.businessId,
          catalogName,
        },
      });

      // Telegram heads-up — same channel as the bot-mode flip alerts.
      sendAlert({
        level: 'info',
        scope: 'store',
        source: 'fwb.wbs-integration.provisionMetaCatalog',
        store: { id: storeId, name: updated.name, slug: updated.slug },
        title: 'Meta Commerce catalog auto-provisioned',
        body:
          `New Meta catalog ${result.catalogId} created under Force AI BM ${result.businessId}. ` +
          `Submit it for Meta review before flipping bot_mode to a native_catalog variant.`,
      }).catch(err => {
        logger.warn({ err }, 'sendAlert failed (non-blocking)');
      });

      res.json({
        success: true,
        data: {
          metaCatalogId: updated.metaCatalogId,
          metaBusinessId: updated.metaBusinessId,
          hasMetaToken: Boolean(updated.metaAccessToken),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
