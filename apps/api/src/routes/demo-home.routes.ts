/**
 * Operator-only channel that fills a DEMO store's home page on its StoreDO (Ruling DEMO-SEED-DO-1). It replaces the home half
 * of `scripts/storedemo/seed.mjs`, which wrote through Prisma/Postgres and stopped working when Postgres was removed (N-17).
 * The demo home documents are built OUTSIDE the Worker by `scripts/storedemo/seed-home-do.mjs` (the same `build<X>Home`
 * builders the old seed used); this route only reads the inputs they need and saves + publishes the result through the
 * page-builder service, so the document goes through the same validation, revision and publish gate as an editor publish.
 *
 *   GET /api/v1/internal/demo-home/:slug   -> { storeId, slug, template, look, rev, source, definition, productIdBySlug }
 *   PUT /api/v1/internal/demo-home/:slug   { baseRev, definition } -> { rev, changed }
 *
 * Dead unless the secret DEMO_SEED_TOKEN is set (wrangler secret): every path answers 404 without it, 403 on a wrong
 * bearer, and 403 NOT_DEMO for any store whose `is_demo` is false, so a merchant store can never be written here.
 * The home page only; the catalogue of a demo store already lives on its DO (cut over with every other store).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v3';
import { runInStoreScope } from '@ebda/database';
import { storeIdBySlug } from '../lib/definer';
import { storeRepo } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { getPageState, publishDraft, saveDraft } from '../services/page-builder.service';
import { clearDemoStoreCache } from '../lib/demo-store';
import logger from '../lib/logger';

const router = Router();
const HOME = 'home';
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function tokenOk(req: Request): boolean {
  const secret = process.env.DEMO_SEED_TOKEN;
  if (!secret || secret.length < 24) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

interface DemoStore {
  id: string;
  slug: string;
  template: string | null;
  look: string | null;
  ownerId: string;
}

/** The demo store behind `slug`, or an AppError: 404 unknown, 403 NOT_DEMO for a real store. */
async function demoStore(slug: string): Promise<DemoStore> {
  if (!SLUG.test(slug)) throw new AppError(400, 'VALIDATION', 'bad slug');
  const id = await storeIdBySlug(slug);
  if (!id) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const repo = await storeRepo(id);
  const row = (await repo.db.store.findUnique({
    where: { id },
    select: { id: true, slug: true, template: true, look: true, ownerId: true, isDemo: true },
  })) as (DemoStore & { isDemo: boolean }) | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  if (row.isDemo !== true) {
    logger.warn({ slug, storeId: id }, '[demo-home] refused: not a demo store');
    throw new AppError(403, 'NOT_DEMO', 'Only a demo store (is_demo) can be seeded here');
  }
  return row;
}

router.use((req: Request, _res: Response, next: NextFunction) => {
  if (!process.env.DEMO_SEED_TOKEN) return next(new AppError(404, 'NOT_FOUND', 'Not found'));
  if (!tokenOk(req)) return next(new AppError(403, 'FORBIDDEN', 'Forbidden'));
  next();
});

router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await demoStore(req.params.slug);
    const data = await runInStoreScope(store.id, async () => {
      const state = await getPageState(store.id, HOME);
      if (!state) throw new AppError(404, 'NOT_FOUND', 'Store not found');
      const repo = await storeRepo(store.id);
      const products = (await repo.db.product.findMany({
        where: { storeId: store.id },
        select: { id: true, slug: true },
      })) as Array<{ id: string; slug: string }>;
      return {
        storeId: store.id,
        slug: store.slug,
        template: store.template,
        look: store.look,
        rev: state.rev,
        source: state.source,
        definition: state.definition,
        productIdBySlug: Object.fromEntries(products.map(p => [p.slug, p.id])),
      };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

const putBody = z.object({
  baseRev: z.number().int().min(0),
  definition: z.record(z.unknown()),
});

router.put('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await demoStore(req.params.slug);
    const body = putBody.parse(req.body);
    const data = await runInStoreScope(store.id, async () => {
      const saved = await saveDraft({
        storeId: store.id,
        pageKey: HOME,
        baseRev: body.baseRev,
        definition: body.definition as never,
        userId: store.ownerId,
      });
      if (!saved.ok)
        throw new AppError(saved.status, saved.code, saved.message, {
          errors: saved.errors ?? [],
        });
      const pub = await publishDraft({
        storeId: store.id,
        pageKey: HOME,
        baseRev: saved.value.rev,
        userId: store.ownerId,
      });
      if (!pub.ok)
        throw new AppError(pub.status, pub.code, pub.message, { errors: pub.errors ?? [] });
      return { rev: pub.value.rev };
    });
    clearDemoStoreCache();
    logger.info({ slug: store.slug, storeId: store.id, rev: data.rev }, '[demo-home] published');
    res.json({ success: true, data: { ...data, changed: true } });
  } catch (e) {
    next(e);
  }
});

export default router;
