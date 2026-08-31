/**
 * WhatsApp Templates Admin Routes — Phase 7
 *
 * Lets a store admin (or super-admin) manage their Force AI canonical
 * WhatsApp template set. Templates are picked from a fixed Force AI
 * library (apps/api/src/lib/wa-templates/definitions.ts) — no custom
 * body text in v1 to keep Meta approval predictable.
 *
 * Routes:
 *   GET  /stores/:id/wa-templates           — list rows + show available defaults
 *   POST /stores/:id/wa-templates/generate  — seed missing rows from defaults
 *   POST /stores/:id/wa-templates/sync      — submit all draft rows to Meta via WBS
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { encryption } from '../services/encryption.service';
import { config } from '../config';
import logger from '../lib/logger';
import {
  TEMPLATES,
  TEMPLATE_SOURCE_KEYS,
  type TemplateSourceKey,
} from '../lib/wa-templates/definitions';
import { buildTemplatesForStore } from '../lib/wa-templates/buildForStore';
import { resolveHeaderHandle } from '../lib/wa-templates/resolveHeaderHandle';

const router = Router({ mergeParams: true });

// ─── GET /stores/:id/wa-templates ────────────────────────────────────────────
//
// Returns every WhatsAppTemplate row for the store, plus the catalog of
// available default templates (so the UI can show "you haven't enabled this
// one yet — click Generate to add it").
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
    try {
      const rows = await prisma.whatsAppTemplate.findMany({
        where: { storeId },
        orderBy: [{ sourceKey: 'asc' }, { language: 'asc' }],
        select: {
          id: true,
          sourceKey: true,
          language: true,
          metaName: true,
          category: true,
          body: true,
          status: true,
          rejectionReason: true,
          metaTemplateId: true,
          lastSyncedAt: true,
          updatedAt: true,
        },
      });

      const catalog = TEMPLATES.map(t => ({
        sourceKey: t.sourceKey,
        language: t.language,
        name: t.name,
        category: t.category,
        description: t.description,
        variableLabels: t.variableLabels,
      }));

      res.json({
        success: true,
        data: {
          rows,
          catalog,
          sourceKeys: TEMPLATE_SOURCE_KEYS,
        },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[wa-templates] list failed');
      res.status(500).json({ success: false, error: 'LIST_FAILED' });
    }
  }
);

// ─── POST /stores/:id/wa-templates/generate ──────────────────────────────────
//
// Idempotently seeds the store's WhatsAppTemplate rows from the default
// library. Existing rows are not overwritten. Only creates the rows; doesn't
// submit to Meta. Use /sync next to push pending rows.
router.post(
  '/generate',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
    try {
      // Phase 7 smart generation: load the store's branding (slug + name)
      // so the templates get per-store names + per-store example body_text
      // values instead of the canonical Force-AI defaults.
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { slug: true, name: true, nameAr: true },
      });
      if (!store) {
        res.status(404).json({ success: false, error: 'STORE_NOT_FOUND' });
        return;
      }

      const templates = buildTemplatesForStore({
        slug: store.slug,
        name: store.name,
        nameAr: store.nameAr,
      });

      const existing = await prisma.whatsAppTemplate.findMany({
        where: { storeId },
        select: { sourceKey: true, language: true },
      });
      const have = new Set(existing.map(r => `${r.sourceKey}:${r.language}`));

      const toCreate = templates.filter(t => !have.has(`${t.sourceKey}:${t.language}`));
      if (toCreate.length === 0) {
        res.json({ success: true, data: { created: 0, message: 'All templates already seeded.' } });
        return;
      }

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

      res.json({ success: true, data: { created: toCreate.length } });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[wa-templates] generate failed');
      res.status(500).json({ success: false, error: 'GENERATE_FAILED' });
    }
  }
);

// ─── POST /stores/:id/wa-templates/reset-rejected ────────────────────────────
//
// For each WhatsAppTemplate row currently in status='rejected', refresh its
// `body` from the latest canonical definitions.ts via buildTemplatesForStore
// AND flip status='draft' + clear rejectionReason. This lets the merchant
// hit "Sync" next and have the rejected templates re-submitted to Meta with
// the corrected body text (typical case: an early-generation row carries a
// historical body that had a placeholder gap / wrong wording, the definitions
// have since been fixed, but the row's `body` and `status` are stale).
//
// Meta tracks rejection cooldowns per name+language. If we resubmit with the
// SAME name within 24h of a rejection, Meta still rejects with the same code.
// Callers can check rejectionReason age + wait if needed; this endpoint
// doesn't rename templates.
router.post(
  '/reset-rejected',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
    try {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { slug: true, name: true, nameAr: true },
      });
      if (!store) {
        res.status(404).json({ success: false, error: 'STORE_NOT_FOUND' });
        return;
      }

      const rejected = await prisma.whatsAppTemplate.findMany({
        where: { storeId, status: 'rejected' },
        select: { id: true, sourceKey: true, language: true, metaName: true },
      });
      if (rejected.length === 0) {
        res.json({
          success: true,
          data: { reset: 0, message: 'No rejected templates to reset.' },
        });
        return;
      }

      const canonical = buildTemplatesForStore({
        slug: store.slug,
        name: store.name,
        nameAr: store.nameAr,
      });

      let reset = 0;
      for (const row of rejected) {
        const built = canonical.find(
          c => c.sourceKey === row.sourceKey && c.language === row.language
        );
        if (!built) continue;
        const bodyComp = built.components.find(c => c.type === 'BODY');
        // ALSO refresh metaName from canonical. When the canonical name
        // bumps versions (e.g. force_order_shipped_v1 → _v2 after a
        // policy-related rewording) the row needs to track the new
        // name so /sync submits under it AND Meta cooldown on the OLD
        // name+language pair doesn't block us. The body refresh + name
        // refresh travel together — they're both part of "regenerate
        // from canonical".
        await prisma.whatsAppTemplate.update({
          where: { id: row.id },
          data: {
            metaName: built.name,
            body: bodyComp?.text || '',
            status: 'draft',
            rejectionReason: null,
            lastSyncedAt: null,
          },
        });
        reset++;
      }

      res.json({
        success: true,
        data: {
          reset,
          message: `Reset ${reset} rejected template${reset === 1 ? '' : 's'} to draft with the latest canonical body. Click Sync to resubmit to Meta.`,
        },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[wa-templates] reset-rejected failed');
      res.status(500).json({ success: false, error: 'RESET_FAILED' });
    }
  }
);

// ─── POST /stores/:id/wa-templates/sync ──────────────────────────────────────
//
// Submits every 'draft' row to WBS, which forwards to Meta. Rows transition
// draft → pending. Approval status will arrive later via the WBS bridge
// callback at POST /api/v1/wa-bridge/templates/status.
//
// Idempotent: rejected rows that the admin wants to retry can be flipped
// back to 'draft' via a separate retry endpoint (TODO v2). For now, sync
// only picks up 'draft'.
const syncBodySchema = z.object({
  // Optional subset filter — sync only these source keys. Omit to sync all drafts.
  sourceKeys: z.array(z.string()).optional(),
});

router.post(
  '/sync',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
    try {
      const parsed = syncBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'INVALID_BODY' });
        return;
      }
      const { sourceKeys } = parsed.data;

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { wbsEnabled: true, wbsApiKey: true },
      });

      if (!store?.wbsEnabled || !store.wbsApiKey) {
        res.status(400).json({
          success: false,
          error: 'WBS_NOT_CONFIGURED',
          message: 'Connect WBS first under Integrations before syncing templates.',
        });
        return;
      }

      let apiKey: string;
      try {
        apiKey = encryption.decrypt(store.wbsApiKey);
      } catch {
        res.status(400).json({ success: false, error: 'WBS_KEY_INVALID' });
        return;
      }

      const drafts = await prisma.whatsAppTemplate.findMany({
        where: {
          storeId,
          status: 'draft',
          ...(sourceKeys && sourceKeys.length > 0 ? { sourceKey: { in: sourceKeys } } : {}),
        },
      });

      if (drafts.length === 0) {
        res.json({
          success: true,
          data: { submitted: 0, message: 'No draft templates to sync.' },
        });
        return;
      }

      // Build the WBS submit payload. Use the per-store builder so the
      // template name + example body_text reflect the merchant's branding,
      // not the Force-AI default. The DB stores body for display; submission
      // needs the full component structure with examples for Meta review.
      const storeForBranding = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          slug: true,
          name: true,
          nameAr: true,
          logo: true,
          wbsTemplateUseLogoHeader: true,
        },
      });
      if (!storeForBranding) {
        res.status(404).json({ success: false, error: 'STORE_NOT_FOUND' });
        return;
      }
      // Phase 7 opt-in: upload the store logo to Meta + get a header_handle
      // so each template carries an IMAGE HEADER. Skipped when opt-in is
      // off or the upload fails — templates still submit (header-less),
      // merchant can retry from the toggle.
      const headerHandle = await resolveHeaderHandle({
        wbsApiKey: apiKey,
        logoUrl: storeForBranding.logo,
        optedIn: storeForBranding.wbsTemplateUseLogoHeader,
        wbsBaseUrl: config.wbsBaseUrl,
      });
      const storeTemplates = buildTemplatesForStore({
        slug: storeForBranding.slug,
        name: storeForBranding.name,
        nameAr: storeForBranding.nameAr,
        headerHandle,
      });
      const definitions = drafts
        .map(row => {
          const built = storeTemplates.find(
            t => t.sourceKey === row.sourceKey && t.language === row.language
          );
          if (!built) return null;
          return {
            sourceKey: row.sourceKey,
            name: built.name,
            language: built.metaLanguage,
            category: built.category,
            components: built.components,
          };
        })
        .filter(Boolean);

      if (definitions.length === 0) {
        res.json({
          success: true,
          data: { submitted: 0, message: 'No matching canonical templates.' },
        });
        return;
      }

      const response = await fetch(`${config.wbsBaseUrl}/api/v1/external/templates/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wbs-api-key': apiKey,
        },
        body: JSON.stringify({ fwbStoreId: storeId, definitions }),
        signal: AbortSignal.timeout(30_000),
      });

      const responseBody = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        results?: Array<{
          sourceKey: string;
          name: string;
          language: string;
          status: string;
          metaTemplateId?: string | null;
          error?: string;
        }>;
        error?: string;
      };

      if (!response.ok || !responseBody.success) {
        logger.error(
          { status: response.status, body: responseBody },
          '[wa-templates] sync failed at WBS'
        );
        res.status(502).json({
          success: false,
          error: responseBody.error || 'WBS_SUBMIT_FAILED',
        });
        return;
      }

      // Update rows in place based on per-template result. updateMany would
      // be cleaner if every result was identical, but they're not (one might
      // be 'pending', another 'rejected' with an error).
      const results = responseBody.results || [];
      let submitted = 0;
      for (const r of results) {
        await prisma.whatsAppTemplate.updateMany({
          where: { storeId, sourceKey: r.sourceKey, language: r.language },
          data: {
            status: r.status === 'pending' ? 'pending' : r.status,
            metaTemplateId: r.metaTemplateId || undefined,
            rejectionReason: r.error || null,
            lastSyncedAt: new Date(),
          },
        });
        if (r.status === 'pending') submitted += 1;
      }

      res.json({ success: true, data: { submitted, results } });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[wa-templates] sync failed');
      res.status(500).json({ success: false, error: 'SYNC_FAILED' });
    }
  }
);

export default router;
