/**
 * Visual builder page documents (Phase 1) — draft / publish / revisions /
 * rollback, mounted at `/admin/stores/:storeId/builder` under `tenantContext`
 * (strict RLS: every query sees only the caller's store).
 *
 *   GET  /pages/:pageKey                     editor state: { rev, definition, source, draftRev, publishedRev }
 *   PUT  /pages/:pageKey/draft               { baseRev, definition } -> { rev }      (no public cache touched)
 *   POST /pages/:pageKey/publish             { baseRev }             -> { rev, layout } (purges every cache layer)
 *   GET  /pages/:pageKey/revisions           ?cursor=<rev>&limit=<n> -> { revisions, nextCursor }
 *   POST /pages/:pageKey/rollback            { targetRev, baseRev }  -> { rev, discardedDraftRev, layout }
 *
 * Concurrency: every write names the head rev it was based on (`baseRev`);
 * a stale one gets 409 REV_CONFLICT with `details.latest` (the current
 * document + rev), never a silent overwrite. Invalid documents get 422 with
 * `details.errors` (JSON-pointer paths, en/ar messages).
 *
 * The rev travels in the JSON body rather than an `If-Match` header so the
 * admin's existing CORS allow-list needs no change.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import {
  HOME_PAGE_KEY,
  getPageState,
  listRevisions,
  publishDraft,
  rollbackToRevision,
  saveDraft,
  type ServiceResult,
} from '../services/page-builder.service';

const router = Router({ mergeParams: true });

/** v1 edits the homepage only; other page keys arrive with CMS pages (roadmap Phase 4). */
const SUPPORTED_PAGES = new Set([HOME_PAGE_KEY]);

const rev = z.number().int().min(0).max(2_147_483_647);
const draftBody = z.object({ baseRev: rev, definition: z.unknown() }).strict();
const publishBody = z.object({ baseRev: rev }).strict();
const rollbackBody = z.object({ baseRev: rev, targetRev: rev.min(1) }).strict();
const listQuery = z.object({
  cursor: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const guard = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess] as const;

function pageKeyOr404(req: Request, res: Response): string | null {
  const { pageKey } = req.params;
  if (!SUPPORTED_PAGES.has(pageKey)) {
    res
      .status(404)
      .json({
        success: false,
        error: { code: 'PAGE_NOT_FOUND', message: `Unknown page "${pageKey}"` },
      });
    return null;
  }
  return pageKey;
}

function sendFailure(res: Response, r: Extract<ServiceResult<unknown>, { ok: false }>): void {
  res.status(r.status).json({
    success: false,
    error: {
      code: r.code,
      message: r.message,
      details: {
        ...(r.errors ? { errors: r.errors } : {}),
        ...(r.latest ? { latest: r.latest } : {}),
      },
    },
  });
}

router.get('/pages/:pageKey', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pageKey = pageKeyOr404(req, res);
    if (!pageKey) return;
    const state = await getPageState(req.params.storeId, pageKey);
    if (!state) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: state });
  } catch (error) {
    next(error);
  }
});

router.put(
  '/pages/:pageKey/draft',
  ...guard,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageKey = pageKeyOr404(req, res);
      if (!pageKey) return;
      const body = draftBody.parse(req.body);
      const r = await saveDraft({
        storeId: req.params.storeId,
        pageKey,
        baseRev: body.baseRev,
        definition: body.definition,
        userId: getAuthUser(req).userId,
      });
      if (!r.ok) return sendFailure(res, r);
      res.json({ success: true, data: { rev: r.value.rev, warnings: r.warnings ?? [] } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/pages/:pageKey/publish',
  ...guard,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageKey = pageKeyOr404(req, res);
      if (!pageKey) return;
      const body = publishBody.parse(req.body);
      const { storeId } = req.params;
      const r = await publishDraft({ storeId, pageKey, baseRev: body.baseRev });
      if (!r.ok) return sendFailure(res, r);
      await auditLog({
        action: 'store.page.published',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { pageKey, rev: r.value.rev },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({
        success: true,
        data: { rev: r.value.rev, layout: r.value.layout, warnings: r.warnings ?? [] },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/pages/:pageKey/revisions',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageKey = pageKeyOr404(req, res);
      if (!pageKey) return;
      const q = listQuery.parse(req.query);
      const data = await listRevisions({
        storeId: req.params.storeId,
        pageKey,
        cursor: q.cursor,
        limit: q.limit,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/pages/:pageKey/rollback',
  ...guard,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageKey = pageKeyOr404(req, res);
      if (!pageKey) return;
      const body = rollbackBody.parse(req.body);
      const { storeId } = req.params;
      const r = await rollbackToRevision({
        storeId,
        pageKey,
        targetRev: body.targetRev,
        baseRev: body.baseRev,
        userId: getAuthUser(req).userId,
      });
      if (!r.ok) return sendFailure(res, r);
      await auditLog({
        action: 'store.page.rolled_back',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { pageKey, rev: r.value.rev, targetRev: body.targetRev },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: r.value });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
