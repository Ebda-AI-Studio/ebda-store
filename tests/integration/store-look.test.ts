/**
 * PUT /stores/:id/look, run the way production runs it: each request is bound to the guarded
 * ebda_app client (code-level tenant guard + strict RLS), the route mounted exactly as
 * apps/api/src/routes/index.ts mounts it (under tenantContext). Fixtures use the owner-role
 * process `prisma` (tests/setup-e2e.ts).
 *
 * Covers: keep vs reset of look-owned theme keys, INVALID_LOOK, the builder (empty store ->
 * published, store with a published revision -> draft only), cache purge, another merchant's
 * store, and a bare legacy template leaving the looks system.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@force/database';
import { getLook } from '@force/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { hasDb } from '../helpers/bundle-fixtures';

const { invalidated, r2Cleanup, failValidation, notReady } = vi.hoisted(() => ({
  invalidated: [] as string[],
  r2Cleanup: vi.fn(),
  failValidation: { on: false },
  notReady: { on: false },
}));
vi.mock('@api/services/r2-cleanup.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/r2-cleanup.service')>();
  return {
    ...real,
    cleanupRemovedJsonUrls: (...a: Parameters<typeof real.cleanupRemovedJsonUrls>) => {
      r2Cleanup(...a);
      return real.cleanupRemovedJsonUrls(...a);
    },
  };
});
// Lets one test make the builder's validation (saveDraft) refuse, and one make EVERY top-level
// section fail publish readiness (as if the whole family still held starter copy).
vi.mock('@force/shared', async importOriginal => {
  const real = await importOriginal<typeof import('@force/shared')>();
  return {
    ...real,
    validateDefinition: (...a: Parameters<typeof real.validateDefinition>) =>
      failValidation.on
        ? Promise.resolve({ ok: false, errors: [] })
        : real.validateDefinition(...a),
    validatePublishReadiness: (...a: Parameters<typeof real.validatePublishReadiness>) =>
      notReady.on
        ? a[0].sections.map((_, i) => ({
            code: 'PLACEHOLDER_COPY' as const,
            path: `/sections/${i}/settings`,
            messageEn: 'starter copy',
            messageAr: 'starter copy',
          }))
        : real.validatePublishReadiness(...a),
  };
});
vi.mock('@api/lib/public-cache', async importOriginal => {
  const real = await importOriginal<typeof import('@api/lib/public-cache')>();
  return {
    ...real,
    invalidateCached: async (key: string) => {
      invalidated.push(key);
      return real.invalidateCached(key);
    },
  };
});

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
        issuer: 'force-api',
        audience: 'force-app',
      }
    );
    return { storeId: store.id, slug: store.slug, token, userId: user.id };
  });
}

const LOOK_ID = 'souq.catalogue';

describe.skipIf(!hasDb)('PUT /stores/:id/look (ebda_app + tenant guard)', () => {
  let app: Express;
  const put = (storeId: string, token: string, body: unknown) =>
    request(app)
      .put(`/api/v1/stores/${storeId}/look`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body as object);
  const row = (storeId: string) =>
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { look: true, template: true, theme: true },
    });
  const revisions = (storeId: string) =>
    prisma.storePageRevision.findMany({
      where: { storeId, pageKey: 'home' },
      orderBy: { rev: 'asc' },
      select: { rev: true, status: true },
    });

  beforeAll(() => {
    app = buildApp();
    expect(getLook(LOOK_ID), 'fixture look exists').toBeTruthy();
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.storePageRevision.deleteMany({ where: { storeId: { in: storeIds } } });
      await tx.store.deleteMany({ where: { id: { in: storeIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
  });

  it('keep: sets look + skin template and leaves the theme untouched', async () => {
    const m = await seedMerchant('keep', { primaryColor: 'X', showQuickAdd: true });
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ look: LOOK_ID, template: getLook(LOOK_ID)!.skin });
    const s = await row(m.storeId);
    expect(s.look).toBe(LOOK_ID);
    expect(s.template).toBe(getLook(LOOK_ID)!.skin);
    expect(s.theme).toEqual({ primaryColor: 'X', showQuickAdd: true });
  });

  it('reset: drops look-owned keys, keeps non-look keys', async () => {
    const m = await seedMerchant('reset', { primaryColor: 'X', showQuickAdd: true });
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'reset' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = await row(m.storeId);
    expect(s.theme).toEqual({ showQuickAdd: true });
    expect(s.look).toBe(LOOK_ID);
  });

  it('theme PUT: density / imageRatio / motion accept only their known values (null deletes)', async () => {
    const m = await seedMerchant('look-keys', { density: 'airy', motion: 'subtle' });
    const putTheme = (body: Record<string, unknown>) =>
      request(app)
        .put(`/api/v1/stores/${m.storeId}/theme`)
        .set({ Authorization: `Bearer ${m.token}` })
        .send(body);
    for (const bad of [
      { density: 'huge' },
      { imageRatio: '16/9' },
      { imageRatio: '1 / 1' },
      { motion: 'wild' },
      { density: 3 },
      { motion: '' },
    ]) {
      const res = await putTheme(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await row(m.storeId)).theme).toEqual({ density: 'airy', motion: 'subtle' });
    const ok = await putTheme({ density: 'compact', imageRatio: '3/4', motion: null });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await row(m.storeId)).theme).toEqual({ density: 'compact', imageRatio: '3/4' });
  });

  it('unknown look: 400 INVALID_LOOK and the store is unchanged', async () => {
    const m = await seedMerchant('bad', { primaryColor: 'X' });
    const res = await put(m.storeId, m.token, { lookId: 'nope.nothing', design: 'reset' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LOOK');
    const s = await row(m.storeId);
    expect(s).toMatchObject({ look: null, template: 'modern', theme: { primaryColor: 'X' } });
  });

  it('empty store: the look family is PUBLISHED as the home page', async () => {
    const m = await seedMerchant('empty');
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.builder).toBe('published');
    const revs = await revisions(m.storeId);
    expect(revs.filter(r => r.status === 'published')).toHaveLength(1);
    expect(revs.filter(r => r.status === 'draft')).toHaveLength(0);
  });

  it('empty store whose every family section is unpublishable: stays a DRAFT, never an empty live home', async () => {
    const m = await seedMerchant('all-unready');
    notReady.on = true;
    try {
      const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.builder).toBe('draft');
    } finally {
      notReady.on = false;
    }
    const revs = await revisions(m.storeId);
    expect(revs.filter(r => r.status === 'published')).toHaveLength(0);
    const draft = await prisma.storePageRevision.findFirstOrThrow({
      where: { storeId: m.storeId, pageKey: 'home', status: 'draft' },
      select: { document: true },
    });
    // The draft keeps the whole family for the merchant to fill, not the emptied copy.
    expect((draft.document as { sections: unknown[] }).sections.length).toBeGreaterThan(0);
    expect((await row(m.storeId)).look).toBe(LOOK_ID);
  });

  it('store with a published revision: a DRAFT is created, published is untouched, caches busted once', async () => {
    const m = await seedMerchant('pub');
    expect((await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' })).status).toBe(200);
    const published = (await revisions(m.storeId)).find(r => r.status === 'published')!;
    await awaitDeferredWork(5000);

    invalidated.length = 0;
    const res = await put(m.storeId, m.token, { lookId: 'qamar.atelier', design: 'keep' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.builder).toBe('draft');
    await awaitDeferredWork(5000);
    const revs = await revisions(m.storeId);
    expect(revs.find(r => r.status === 'published')).toEqual(published);
    expect(revs.filter(r => r.status === 'draft')).toHaveLength(1);
    expect(invalidated.filter(k => k === `public:store:${m.storeId}`)).toHaveLength(1);
    expect(invalidated).toContain(`public:store:${m.slug}`);
  });

  it('legacy store with customised layout_settings and no builder revision: DRAFT only, layout + R2 untouched', async () => {
    const layout = {
      brandStory: { enabled: true, titleEn: 'Our story', image: 'https://pub-x.r2.dev/story.jpg' },
    };
    const m = await seedMerchant('legacy-layout', {}, layout);
    const before = await prisma.store.findUniqueOrThrow({
      where: { id: m.storeId },
      select: { layoutSettings: true },
    });
    r2Cleanup.mockClear();
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.builder).toBe('draft');
    await awaitDeferredWork(5000);
    const after = await prisma.store.findUniqueOrThrow({
      where: { id: m.storeId },
      select: { layoutSettings: true },
    });
    expect(JSON.stringify(after.layoutSettings)).toBe(JSON.stringify(before.layoutSettings));
    expect(r2Cleanup).not.toHaveBeenCalled();
    const revs = await revisions(m.storeId);
    expect(revs.map(r => r.status)).toEqual(['draft']);
  });

  it('a builder refusal leaves look/template/theme unchanged and the error propagates', async () => {
    const m = await seedMerchant('refuse', { primaryColor: 'X' });
    failValidation.on = true;
    try {
      const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'reset' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_DEFINITION');
    } finally {
      failValidation.on = false;
    }
    expect(await row(m.storeId)).toMatchObject({
      look: null,
      template: 'modern',
      theme: { primaryColor: 'X' },
    });
  });

  it("reset strips look keys from a pending draft's theme patch", async () => {
    const m = await seedMerchant('draft-theme', { primaryColor: 'X' });
    expect((await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' })).status).toBe(200);
    const pub = await prisma.storePageRevision.findFirstOrThrow({
      where: { storeId: m.storeId, pageKey: 'home', status: 'published' },
    });
    await prisma.storePageRevision.create({
      data: {
        storeId: m.storeId,
        pageKey: 'home',
        rev: pub.rev + 1,
        status: 'draft',
        schemaVersion: pub.schemaVersion,
        document: { ...(pub.document as object), theme: { primaryColor: '#112233' } },
        docBytes: 10,
        baseRev: pub.rev,
      },
    });
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'reset' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const draft = await prisma.storePageRevision.findFirstOrThrow({
      where: { storeId: m.storeId, pageKey: 'home', status: 'draft' },
    });
    expect(
      (draft.document as { theme?: Record<string, unknown> }).theme?.primaryColor
    ).toBeUndefined();
  });

  it('keeps createdBy on the revision it writes', async () => {
    const m = await seedMerchant('actor');
    expect((await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' })).status).toBe(200);
    const rev = await prisma.storePageRevision.findFirstOrThrow({
      where: { storeId: m.storeId, pageKey: 'home' },
      select: { createdBy: true },
    });
    expect(rev.createdBy).toBe(m.userId);
  });

  it("another merchant's store is refused and not modified", async () => {
    const a = await seedMerchant('own');
    const b = await seedMerchant('intruder');
    const res = await put(a.storeId, b.token, { lookId: LOOK_ID, design: 'reset' });
    expect([403, 404]).toContain(res.status);
    expect((await row(a.storeId)).look).toBeNull();
  });

  it('PUT /template with a bare legacy template clears the look', async () => {
    const m = await seedMerchant('legacy');
    await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
    expect((await row(m.storeId)).look).toBe(LOOK_ID);
    const res = await request(app)
      .put(`/api/v1/stores/${m.storeId}/template`)
      .set({ Authorization: `Bearer ${m.token}` })
      .send({ template: 'classic' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = await row(m.storeId);
    expect(s.look).toBeNull();
    expect(s.template).toBe('classic');
  });

  it('PUT /theme with a null value removes that key', async () => {
    const m = await seedMerchant('null', { accentColor: 'Y', fontFamily: 'Cairo' });
    const res = await request(app)
      .put(`/api/v1/stores/${m.storeId}/theme`)
      .set({ Authorization: `Bearer ${m.token}` })
      .send({ accentColor: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(m.storeId)).theme).toEqual({ fontFamily: 'Cairo' });
  });
});
