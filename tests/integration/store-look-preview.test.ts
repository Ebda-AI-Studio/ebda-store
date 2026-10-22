/**
 * POST /stores/:id/look/preview (Task 9, Ruling EP-3), run the way production runs it: the guarded
 * ebda_app client under tenantContext. Proves: the preview writes nothing; applying it writes exactly the
 * document it showed; a page that moved since the preview is refused (409 DRAFT_MOVED) with nothing
 * written; another merchant's store and an unbuilt or unknown look are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  prisma,
  withRlsBypass,
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
} from '@ebda/database';
import { getLook, layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { saveDraft } from '@api/services/page-builder.service';
import { hasDb } from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const run = crypto.randomUUID().slice(0, 8);
const userIds: string[] = [];
const storeIds: string[] = [];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/stores', tenantContext, storeRoutes);
  app.use(errorHandler);
  return app;
}

async function seedMerchant(
  tag: string,
  theme: Record<string, unknown> = {},
  layoutSettings?: Record<string, unknown>
) {
  return withRlsBypass(async tx => {
    const email = `look-${tag}-${run}@test.local`;
    const user = await tx.user.create({
      data: {
        email,
        passwordHash: 'x',
        firstName: 'Look',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await tx.store.create({
      data: {
        name: `look-${tag}-${run}`,
        slug: `look-${tag}-${run}`,
        template: 'modern',
        currency: 'EGP',
        ownerId: user.id,
        status: 'active',
        theme: theme as object,
        ...(layoutSettings ? { layoutSettings: layoutSettings as object } : {}),
      },
    });
    userIds.push(user.id);
    storeIds.push(store.id);
    const token = jwt.sign(
      { userId: user.id, email, role: 'store_admin', tv: 0 },
      config.jwtSecret,
      {
        expiresIn: '10m',
        issuer: 'ebda-api',
        audience: 'ebda-app',
      }
    );
    return { storeId: store.id, slug: store.slug, token, userId: user.id };
  });
}

const LOOK = 'qamar.vitrine';
const HERO = {
  hero: {
    enabled: true,
    mode: 'slider',
    slides: [
      { image: 'https://m.ebda.app/a.jpg', headline: 'Fresh dates', headlineAr: 'تمور طازجة' },
    ],
  },
};

describe.skipIf(!hasDb)('POST /stores/:id/look/preview (ebda_app + tenant guard)', () => {
  let app: Express;
  const post = (storeId: string, token: string, body: unknown) =>
    request(app)
      .post(`/api/v1/stores/${storeId}/look/preview`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body as object);
  const put = (storeId: string, token: string, body: unknown) =>
    request(app)
      .put(`/api/v1/stores/${storeId}/look`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body as object);
  const rows = (storeId: string) =>
    prisma.storePageRevision.findMany({
      where: { storeId, pageKey: 'home' },
      orderBy: { rev: 'asc' },
      select: { rev: true, status: true },
    });
  const storeRow = (storeId: string) =>
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { look: true, template: true, theme: true },
    });
  /** The merchant's own page: a published hero with a slide, so a switch has content to keep. */
  const asStore = <T>(storeId: string, fn: () => Promise<T>) =>
    asApp(() => runInTenantContext(storeId, fn));

  beforeAll(() => {
    app = buildApp();
    expect(getLook(LOOK)?.status).toBe('built');
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.storePageRevision.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.store.deleteMany({ where: { id: { in: storeIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
  });

  it('returns the proposed draft, a report that keeps the content, and a token, and writes nothing', async () => {
    const m = await seedMerchant('writes-nothing', { primaryColor: 'X' }, HERO);
    const before = { rows: await rows(m.storeId), store: await storeRow(m.storeId) };
    const res = await post(m.storeId, m.token, { lookId: LOOK, design: 'reset' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const { draft, report, revisionToken, look, skinChange } = res.body.data;
    expect(look).toBe(LOOK);
    expect(typeof revisionToken).toBe('string');
    expect(draft.pageKey).toBe('home');
    // the merchant's slide survives the proposal
    const hero = draft.sections.find((s: { type: string }) => s.type === 'hero');
    expect(hero.blocks.map((b: { settings: { headline: string } }) => b.settings.headline)).toEqual(
      ['Fresh dates']
    );
    expect(report.contentChanged).toEqual([]);
    expect(report.keptContent.map((s: { type: string }) => s.type)).toContain('hero');
    // a reset clears the look-owned theme key the store had
    expect(report.themeKeysReset).toEqual(['primaryColor']);
    expect(skinChange).toEqual({ from: 'modern', to: getLook(LOOK)!.skin });
    // nothing was written: no revision row, the same look, template and theme
    expect(await rows(m.storeId)).toEqual(before.rows);
    expect(await storeRow(m.storeId)).toEqual(before.store);
  });

  it('applying with the token writes exactly the proposed document', async () => {
    const m = await seedMerchant('apply-equals', {}, HERO);
    const preview = await post(m.storeId, m.token, { lookId: LOOK, design: 'keep' });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const res = await put(m.storeId, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.body.data.revisionToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // a store with content takes the draft path: the draft IS the preview
    const written = await prisma.storePageRevision.findFirstOrThrow({
      where: { storeId: m.storeId, pageKey: 'home', status: { in: ['draft', 'published'] } },
      orderBy: { rev: 'desc' },
      select: { document: true },
    });
    expect(written.document).toEqual(preview.body.data.draft);
    expect((await storeRow(m.storeId)).look).toBe(LOOK);
  });

  it('a page that moved since the preview is refused with DRAFT_MOVED and nothing is written', async () => {
    const m = await seedMerchant('moved', {}, HERO);
    const preview = await post(m.storeId, m.token, { lookId: LOOK, design: 'keep' });
    // the merchant edits in another tab: a new draft revision
    const doc = layoutToDefinition(resolveLayoutSettings(HERO, 'modern'));
    const saved = await asStore(m.storeId, () =>
      saveDraft({
        storeId: m.storeId,
        pageKey: 'home',
        baseRev: 0,
        definition: doc,
        userId: m.userId,
      })
    );
    expect(saved).toMatchObject({ ok: true });
    const revsBefore = await rows(m.storeId);
    const res = await put(m.storeId, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.body.data.revisionToken,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DRAFT_MOVED');
    expect(await rows(m.storeId)).toEqual(revsBefore);
    expect((await storeRow(m.storeId)).look).toBeNull();
    // without a token the apply still works (the old behaviour is unchanged)
    const plain = await put(m.storeId, m.token, { lookId: LOOK, design: 'keep' });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
  });

  it('a theme or layout change with no new revision also moves the token (DRAFT_MOVED)', async () => {
    const m = await seedMerchant('moved-theme', {}, HERO);
    const preview = await post(m.storeId, m.token, { lookId: LOOK, design: 'keep' });
    await withRlsBypass(tx =>
      tx.store.update({
        where: { id: m.storeId },
        data: { theme: { primaryColor: '#123456' } },
      })
    );
    const res = await put(m.storeId, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.body.data.revisionToken,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DRAFT_MOVED');
    expect((await storeRow(m.storeId)).look).toBeNull();
  });

  it("refuses another merchant's store, an unknown look and a look that is not built", async () => {
    const a = await seedMerchant('owner-a', {}, HERO);
    const b = await seedMerchant('owner-b', {}, HERO);
    const foreign = await post(a.storeId, b.token, { lookId: LOOK, design: 'keep' });
    expect([403, 404]).toContain(foreign.status);
    expect((await post(a.storeId, a.token, { lookId: 'nope.nope', design: 'keep' })).status).toBe(
      400
    );
    const unbuilt = ['lamma.table', 'dahab.worn', 'jasmine.clinic']
      .map(id => getLook(id))
      .find(l => l && l.status !== 'built');
    if (unbuilt) {
      const res = await post(a.storeId, a.token, { lookId: unbuilt.id, design: 'keep' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LOOK_NOT_AVAILABLE');
    }
    // no body fields beyond the contract
    expect(
      (await post(a.storeId, a.token, { lookId: LOOK, design: 'keep', revisionToken: 'x' })).status
    ).toBe(400);
  });
});
