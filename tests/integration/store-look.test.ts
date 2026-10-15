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
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { definitionToLayout, getLook } from '@ebda/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { hasDb } from '../helpers/bundle-fixtures';

const { invalidated, r2Cleanup, failValidation, notReady, lookMix, failAfterBuilder } = vi.hoisted(
  () => ({
    invalidated: [] as string[],
    r2Cleanup: vi.fn(),
    failValidation: { on: false },
    notReady: { on: false },
    // A section mix injected into a registered look. Lookbook and Vitrine have real mixes since
    // Tasks 7-8 (pinned in tests/unit/looks-section-mix.test.ts); these cases inject controlled
    // ones (Atelier's own design values equal the skin defaults, so they prove nothing).
    lookMix: {} as Record<string, unknown[]>,
    // Makes applyLook's store-row update fail AFTER the builder step (Ruling LOOKS-10 retry path).
    failAfterBuilder: { on: false },
  })
);
vi.mock('@api/services/page-builder.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/page-builder.service')>();
  return {
    ...real,
    applyFamilyForLook: async (...a: Parameters<typeof real.applyFamilyForLook>) => {
      const out = await real.applyFamilyForLook(...a);
      if (failAfterBuilder.on) {
        failAfterBuilder.on = false;
        throw new Error('simulated store update failure after the builder step');
      }
      return out;
    },
  };
});
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
vi.mock('@ebda/shared', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/shared')>();
  const getLook = (id: string | null | undefined) => {
    const look = real.getLook(id);
    return look && id && lookMix[id] ? { ...look, sections: lookMix[id] as never } : look;
  };
  return {
    ...real,
    getLook,
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
    // LOOKS-15: the published page is derived for the NEW skin + look (the seeded store is on
    // `modern`, whose baseline sets a rounded-square product card), so no skin card shape or
    // aspect is baked into the document and the look's image ratio is the default.
    const doc = (
      await prisma.storePageRevision.findFirstOrThrow({
        where: { storeId: m.storeId, pageKey: 'home', status: 'published' },
        select: { document: true },
      })
    ).document as Parameters<typeof definitionToLayout>[0];
    const published = definitionToLayout(doc);
    expect(published.productCardDefaults?.cardShape).toBeUndefined();
    expect(published.productCardDefaults?.cardAspect).toBeUndefined();
    for (const sec of doc.sections.filter(x => x.type === 'product-carousel'))
      expect((sec.settings as Record<string, unknown>).cardShape, sec.id).toBeUndefined();
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

  describe('look switch design keys (C6/C8, fix round 1)', () => {
    type Doc = {
      appliedLook?: string;
      sections: { type: string; settings: Record<string, unknown>; blocks?: unknown }[];
    };
    const docOf = async (storeId: string, status: 'draft' | 'published') =>
      (await prisma.storePageRevision.findFirstOrThrow({
        where: { storeId, pageKey: 'home', status },
        select: { id: true, document: true },
      })) as { id: string; document: Doc };
    const sec = (doc: Doc, type: string) => doc.sections.find(x => x.type === type)!.settings;
    const ok = async (m: { storeId: string; token: string }, lookId: string) =>
      expect((await put(m.storeId, m.token, { lookId, design: 'keep' })).status).toBe(200);
    // Two columns + a framed hero on "Lookbook"; the same sections with NO design keys on
    // "Vitrine" (C6 resets them). Vitrine's real mix drops the category grid, so it is injected.
    const TWO = [
      { type: 'hero', design: { presentation: 'framed' } },
      { type: 'category-grid', design: { desktopColumns: 2 } },
      { type: 'image-text' },
    ];
    const BARE = [{ type: 'hero' }, { type: 'category-grid' }, { type: 'image-text' }];

    beforeAll(() => {
      lookMix['qamar.lookbook'] = TWO;
      lookMix['qamar.vitrine'] = BARE;
    });
    afterAll(() => {
      delete lookMix['qamar.lookbook'];
      delete lookMix['qamar.vitrine'];
    });

    it('keep from a layout-built page applies the look; a look-owned key returns to the skin default', async () => {
      const a = await seedMerchant('mixa');
      await ok(a, LOOK_ID);
      await ok(a, 'qamar.lookbook');
      const onLookbook = (await docOf(a.storeId, 'draft')).document;
      expect(onLookbook.appliedLook).toBe('qamar.lookbook');
      expect(sec(onLookbook, 'hero').presentation).toBe('framed');
      expect(sec(onLookbook, 'category-grid').desktopColumns).toBe(2);
      await ok(a, 'qamar.vitrine');
      const onVitrine = (await docOf(a.storeId, 'draft')).document;
      expect(onVitrine.appliedLook).toBe('qamar.vitrine');
      // Back to the qamar skin's own defaults, not registry preset 0 (3 columns, unset hero).
      expect(sec(onVitrine, 'category-grid').desktopColumns).toBe(4);
      expect(sec(onVitrine, 'hero').presentation).toBe('full-bleed');
      await awaitDeferredWork(5000);
    });

    it('Atelier -> the REAL Vitrine mix: bands, one quote and the frame line pass saveDraft under ebda_app', async () => {
      const injected = lookMix['qamar.vitrine'];
      delete lookMix['qamar.vitrine'];
      try {
        const v = await seedMerchant('vitrine-real');
        await ok(v, LOOK_ID);
        await ok(v, 'qamar.atelier');
        await ok(v, 'qamar.vitrine');
        const draft = (await docOf(v.storeId, 'draft')).document;
        expect(draft.appliedLook).toBe('qamar.vitrine');
        expect(sec(draft, 'hero')).toMatchObject({ presentation: 'framed', frame: 'line' });
        expect(sec(draft, 'collection-list')).toMatchObject({
          tileShape: 'band',
          headingAr: 'تسوّق حسب المناسبة',
        });
        expect(sec(draft, 'testimonials').layout).toBe('single');
        // content seeded by Atelier is kept (B1-3): only design keys follow Vitrine
        expect(sec(draft, 'featured-collection')).toMatchObject({
          headingAr: 'وصل حديثًا',
          columns: 4,
          mobileColumns: 2,
        });
        expect((await row(v.storeId)).look).toBe('qamar.vitrine');
        await awaitDeferredWork(5000);
      } finally {
        lookMix['qamar.vitrine'] = injected;
      }
    });

    it('keep: a hand-set hero presentation survives the switch', async () => {
      const b = await seedMerchant('mixb');
      await ok(b, LOOK_ID);
      await ok(b, 'qamar.atelier');
      const draft = await docOf(b.storeId, 'draft');
      const edited = {
        ...draft.document,
        sections: draft.document.sections.map(x =>
          x.type === 'hero' ? { ...x, settings: { ...x.settings, presentation: 'framed' } } : x
        ),
      };
      await withRlsBypass(tx =>
        tx.storePageRevision.update({
          where: { id: draft.id },
          data: { document: edited as object },
        })
      );
      await ok(b, 'qamar.vitrine');
      expect(sec((await docOf(b.storeId, 'draft')).document, 'hero').presentation).toBe('framed');
      await awaitDeferredWork(5000);
    });

    it("A -> B with B's draft discarded, then B -> C: the published document's appliedLook is the baseline", async () => {
      const c = await seedMerchant('mixc');
      await ok(c, 'qamar.lookbook'); // fresh store: published, composed by Lookbook
      const published = (await docOf(c.storeId, 'published')).document;
      expect(published.appliedLook).toBe('qamar.lookbook');
      expect(sec(published, 'category-grid').desktopColumns).toBe(2);
      await ok(c, 'qamar.atelier'); // draft only; store row now says Atelier
      const atelierDraft = await docOf(c.storeId, 'draft');
      await withRlsBypass(tx => tx.storePageRevision.delete({ where: { id: atelierDraft.id } }));
      await ok(c, 'qamar.vitrine');
      const onVitrine = (await docOf(c.storeId, 'draft')).document;
      // Lookbook's 2 columns are look-owned (untouched since Lookbook set them): reset, not kept
      // as if the merchant had chosen them (the store row's Atelier never set the key).
      expect(sec(onVitrine, 'category-grid').desktopColumns).toBe(4);
      expect(onVitrine.appliedLook).toBe('qamar.vitrine');
      await awaitDeferredWork(5000);
    });

    it('a retry after the store update failed converges on the same draft as one clean switch', async () => {
      const once = await seedMerchant('retry1');
      await ok(once, LOOK_ID);
      await ok(once, 'qamar.lookbook');

      const twice = await seedMerchant('retry2');
      await ok(twice, LOOK_ID);
      failAfterBuilder.on = true;
      const failed = await put(twice.storeId, twice.token, {
        lookId: 'qamar.lookbook',
        design: 'keep',
      });
      expect(failed.status).toBe(500);
      expect((await row(twice.storeId)).look).toBe(LOOK_ID); // the store row was not written
      await ok(twice, 'qamar.lookbook');

      const shape = (d: Doc) => ({
        appliedLook: d.appliedLook,
        sections: d.sections.map(x => ({ type: x.type, settings: x.settings, blocks: x.blocks })),
      });
      expect(shape((await docOf(twice.storeId, 'draft')).document)).toEqual(
        shape((await docOf(once.storeId, 'draft')).document)
      );
      expect(await row(twice.storeId)).toMatchObject({ look: 'qamar.lookbook', template: 'qamar' });
      await awaitDeferredWork(5000);
    });
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
