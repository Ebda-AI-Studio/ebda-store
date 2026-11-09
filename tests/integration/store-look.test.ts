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
import { RETIRED_TEMPLATES, definitionToLayout, getLook } from '@ebda/shared';
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
    // The plumbing fixture look (LOOK_ID below) has no mix and no skin of its own. Since #111 only
    // BUILT looks can be switched into, and every built look now has a mix, so the fixture is
    // presented as built here (the registry itself is untouched).
    // The Jasmine looks are presented as built too: they flip to `built` in the same phase (B3
    // Task 6), and the switch mechanics below must be proven with their real mixes either way.
    // The Lamma looks get the same treatment until Phase B4 Task 7 flips them. The plumbing fixture
    // is `dahab.worn` (no mix, no skin of its own): `lamma.table` was the fixture until B4 gave it a mix.
    if (look && (id === 'dahab.worn' || id?.startsWith('jasmine.') || id?.startsWith('lamma.')))
      return { ...look, status: 'built' as const };
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
  // A per-CALL id, not the per-file `run`: a retry re-runs the test body against the same database
  // and a fixture keyed on the file id trips the unique email/slug index (retry-safe fixtures).
  const call = `${run}-${crypto.randomBytes(3).toString('hex')}`;
  return withRlsBypass(async tx => {
    const email = `look-${tag}-${call}@test.local`;
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
        name: `look-${tag}-${call}`,
        slug: `look-${tag}-${call}`,
        template: 'dahab',
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

// A look with no mix and no skin of its own (still on minimal): keeps these cases about the
// switch plumbing; the Souq and Jasmine mixes have their own cases below and in
// souq-look-mix.test.ts / jasmine-look-mix.test.ts. (Jasmine had this role until Phase B3 gave it a
// skin and three mixes; Lamma is the next designed-only look.)
const LOOK_ID = 'dahab.worn';

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

  it('reset: also drops the optional look UI tokens a merchant stored (W2a)', async () => {
    const m = await seedMerchant('reset-ui', {
      wordmarkSize: 'xl',
      overPhotoChrome: 'soft',
      receiptStyle: 'device',
      cardCta: 'quiet',
      cardHover: 'lift',
      showQuickAdd: true,
    });
    const res = await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'reset' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(m.storeId)).theme).toEqual({ showQuickAdd: true });
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
      { wordmarkSize: 'huge' },
      { overPhotoChrome: 'glass' },
      { receiptStyle: 'thermal' },
      { cardCta: 'slab' },
      { cardHover: 'bounce' },
      { cardBadge: 'red' },
    ]) {
      const res = await putTheme(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await row(m.storeId)).theme).toEqual({ density: 'airy', motion: 'subtle' });
    const ok = await putTheme({ density: 'compact', imageRatio: '3/4', motion: null });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await row(m.storeId)).theme).toEqual({ density: 'compact', imageRatio: '3/4' });
    const ui = await putTheme({ wordmarkSize: 'lg', overPhotoChrome: 'bare', receiptStyle: null });
    expect(ui.status, JSON.stringify(ui.body)).toBe(200);
    expect((await row(m.storeId)).theme).toEqual({
      density: 'compact',
      imageRatio: '3/4',
      wordmarkSize: 'lg',
      overPhotoChrome: 'bare',
    });
    // W2b card tokens: known values only, merchant-storable like the W2a ones.
    const card = await putTheme({ cardCta: 'quiet', cardHover: 'lift', cardBadge: 'accent' });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect((await row(m.storeId)).theme).toMatchObject({
      cardCta: 'quiet',
      cardHover: 'lift',
      cardBadge: 'accent',
    });
  });

  it('unknown look: 400 INVALID_LOOK and the store is unchanged', async () => {
    const m = await seedMerchant('bad', { primaryColor: 'X' });
    const res = await put(m.storeId, m.token, { lookId: 'nope.nothing', design: 'reset' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LOOK');
    const s = await row(m.storeId);
    expect(s).toMatchObject({ look: null, template: 'dahab', theme: { primaryColor: 'X' } });
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
    // `dahab`, whose baseline sets a square product card), so no skin card shape or
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

  it.each(['souq.catalogue', 'souq.night', 'souq.showroom'])(
    'Souq %s on an empty store: the souq skin + look are set and a home revision is written',
    async id => {
      const m = await seedMerchant(`mix-${id.split('.')[1]}`);
      const res = await put(m.storeId, m.token, { lookId: id, design: 'keep' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await row(m.storeId)).toMatchObject({ look: id, template: 'souq' });
      const revs = await revisions(m.storeId);
      expect(revs.length).toBeGreaterThan(0);
      const doc = (
        await prisma.storePageRevision.findFirstOrThrow({
          where: { storeId: m.storeId, pageKey: 'home' },
          orderBy: { rev: 'desc' },
          select: { document: true },
        })
      ).document as { sections: Array<{ type: string }> };
      // only the mix's section types are written (an unpublishable one may be left out)
      const mixTypes = new Set(getLook(id)!.sections!.map(x => x.type));
      for (const sec of doc.sections) expect(mixTypes.has(sec.type), sec.type).toBe(true);
    }
  );

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
        // The first switch is Atelier itself (not the mix-less plumbing fixture): the fixture's own
        // family (Dahab) now seeds a featured collection with the registry preset's heading, and
        // the point here is that what ATELIER seeded survives Atelier -> Vitrine.
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
      template: 'dahab',
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

  it('PUT /template refuses a bare legacy template and leaves the look alone (#111)', async () => {
    // Since #111 nobody can switch INTO a bare skin (StoreService.updateTemplate): a store moves
    // between templates only through a look. The old case asserted the pre-#111 behaviour (200,
    // look cleared) and had been red on main since.
    const m = await seedMerchant('legacy');
    await put(m.storeId, m.token, { lookId: LOOK_ID, design: 'keep' });
    expect((await row(m.storeId)).look).toBe(LOOK_ID);
    const res = await request(app)
      .put(`/api/v1/stores/${m.storeId}/template`)
      .set({ Authorization: `Bearer ${m.token}` })
      .send({ template: RETIRED_TEMPLATES[1] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('TEMPLATE_RETIRED');
    const s = await row(m.storeId);
    expect(s.look).toBe(LOOK_ID);
    expect(s.template).toBe(getLook(LOOK_ID)!.skin);
  });

  // Phase B3 Task 4: the three REAL Jasmine mixes, applied the way production applies them
  // (ebda_app + tenant guard), switched across looks and across templates.
  describe('Jasmine mixes (real, Phase B3)', () => {
    type Doc = {
      appliedLook?: string;
      sections: Array<{ type: string; settings: Record<string, unknown>; blocks?: unknown[] }>;
    };
    const draftOf = async (storeId: string) =>
      (
        (await prisma.storePageRevision.findFirstOrThrow({
          // a fresh store's first switch PUBLISHES; every later one is a draft: read the newest revision
          where: { storeId, pageKey: 'home' },
          orderBy: { rev: 'desc' },
          select: { document: true },
        })) as { document: Doc }
      ).document;
    const sec = (doc: Doc, type: string) => doc.sections.find(x => x.type === type)?.settings;
    const ok = async (m: { storeId: string; token: string }, lookId: string) => {
      const res = await put(m.storeId, m.token, { lookId, design: 'keep' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };

    it('Apothecary -> Bloom -> Clinic -> Apothecary: the store lands on the jasmine skin, the mix follows, no design leaks', async () => {
      const m = await seedMerchant('jasmine-cycle');
      await ok(m, 'jasmine.apothecary');
      let s = await row(m.storeId);
      expect(s).toMatchObject({ look: 'jasmine.apothecary', template: 'jasmine' });
      let doc = await draftOf(m.storeId);
      expect(doc.appliedLook).toBe('jasmine.apothecary');
      expect(sec(doc, 'category-grid')).toMatchObject({ source: 'tags', layout: 'chips' });
      expect(sec(doc, 'featured-collection')?.bgColor).toBe('token:inverse');

      await ok(m, 'jasmine.bloom');
      doc = await draftOf(m.storeId);
      expect(sec(doc, 'category-grid')).toMatchObject({ layout: 'rail' });
      expect(sec(doc, 'category-grid')?.source).not.toBe('tags'); // look-owned, returned to default
      expect(sec(doc, 'featured-collection')?.bgColor).not.toBe('token:inverse');
      expect(sec(doc, 'hero')?.presentation).toBe('framed');

      await ok(m, 'jasmine.clinic');
      doc = await draftOf(m.storeId);
      expect(doc.sections.map(x => x.type).slice(0, 3)).toEqual([
        'category-grid',
        'product-spotlight',
        'steps',
      ]);
      expect(sec(doc, 'category-grid')).toMatchObject({ source: 'tags', layout: 'chips' });
      expect((doc.sections.find(x => x.type === 'steps')?.blocks ?? []).length).toBe(3);
      // T7 (Ruling T7-1): the signature section sits right after the main grid
      const types = doc.sections.map(x => x.type);
      expect(types[types.indexOf('featured-collection') + 1]).toBe('key-ingredients');
      s = await row(m.storeId);
      expect(s).toMatchObject({ look: 'jasmine.clinic', template: 'jasmine' });

      await ok(m, 'jasmine.apothecary');
      doc = await draftOf(m.storeId);
      expect(sec(doc, 'featured-collection')?.bgColor).toBe('token:inverse');
      // Apothecary's mix uses the routine steps too, so they stay on its draft ...
      expect((doc.sections.find(x => x.type === 'steps')?.blocks ?? []).length).toBe(3);
      // ... and an UNTOUCHED section the outgoing look seeded leaves the DRAFT when the incoming
      // look does not use it (B1-45); the PUBLISHED page is never touched by a switch.
      await ok(m, 'jasmine.bloom');
      doc = await draftOf(m.storeId);
      expect(doc.sections.some(x => x.type === 'steps')).toBe(false);
      const published = (
        (await prisma.storePageRevision.findFirstOrThrow({
          where: { storeId: m.storeId, pageKey: 'home', status: 'published' },
          select: { document: true },
        })) as { document: Doc }
      ).document;
      expect(published.appliedLook).toBe('jasmine.apothecary'); // the first switch of a fresh store
      expect(published.sections.some(x => x.type === 'steps')).toBe(true);
      await awaitDeferredWork(5000);
    });

    it('Souq <-> Jasmine and Qamar <-> Jasmine switches keep the skin and the look in step', async () => {
      const m = await seedMerchant('jasmine-cross');
      await ok(m, 'souq.night');
      expect(await row(m.storeId)).toMatchObject({ look: 'souq.night', template: 'souq' });
      await ok(m, 'jasmine.bloom');
      expect(await row(m.storeId)).toMatchObject({ look: 'jasmine.bloom', template: 'jasmine' });
      await ok(m, 'qamar.atelier');
      expect(await row(m.storeId)).toMatchObject({ look: 'qamar.atelier', template: 'qamar' });
      await ok(m, 'jasmine.clinic');
      expect(await row(m.storeId)).toMatchObject({ look: 'jasmine.clinic', template: 'jasmine' });
      const doc = await draftOf(m.storeId);
      expect(sec(doc, 'category-grid')).toMatchObject({ source: 'tags', layout: 'chips' });
      await awaitDeferredWork(5000);
    });
  });

  // Phase B4 Task 3/4: the three REAL Lamma mixes, applied the way production applies them.
  describe('Lamma mixes (real, Phase B4)', () => {
    type Doc = {
      appliedLook?: string;
      sections: Array<{ type: string; settings: Record<string, unknown>; blocks?: unknown[] }>;
    };
    const draftOf = async (storeId: string) =>
      (
        (await prisma.storePageRevision.findFirstOrThrow({
          where: { storeId, pageKey: 'home' },
          orderBy: { rev: 'desc' },
          select: { document: true },
        })) as { document: Doc }
      ).document;
    const sec = (doc: Doc, type: string) => doc.sections.find(x => x.type === type)?.settings;
    const ok = async (m: { storeId: string; token: string }, lookId: string) => {
      const res = await put(m.storeId, m.token, { lookId, design: 'keep' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };

    it('Table -> Notebook -> Market -> Table: the store lands on the lamma skin, the mix follows, no design leaks', async () => {
      const m = await seedMerchant('lamma-cycle');
      await ok(m, 'lamma.table');
      expect(await row(m.storeId)).toMatchObject({ look: 'lamma.table', template: 'lamma' });
      let doc = await draftOf(m.storeId);
      expect(doc.appliedLook).toBe('lamma.table');
      expect(doc.sections.map(x => x.type).slice(0, 5)).toEqual([
        'hero',
        'product-carousel',
        'featured-collection',
        // T7 (Ruling T7-1): the template's signature section, after the main grid
        'kitchen-days',
        'maker-profile',
      ]);
      expect(sec(doc, 'featured-collection')).toMatchObject({ layout: 'menu', tabs: 'categories' });
      expect(sec(doc, 'maker-profile')?.variant).toBe('strip');

      await ok(m, 'lamma.notebook');
      doc = await draftOf(m.storeId);
      expect(sec(doc, 'maker-profile')?.variant).toBe('lead');
      expect(doc.sections.filter(x => x.type === 'kitchen-days')).toHaveLength(1);
      // Table's menu layout must not leak into Notebook's light-band grid
      expect(sec(doc, 'featured-collection')?.layout).not.toBe('menu');
      expect(sec(doc, 'featured-collection')).toMatchObject({
        bgColor: 'token:inverse',
        columns: 2,
      });

      await ok(m, 'lamma.market');
      doc = await draftOf(m.storeId);
      expect(doc.sections.filter(x => x.type === 'kitchen-days')).toHaveLength(1);
      expect(sec(doc, 'category-grid')).toMatchObject({
        layout: 'tiles',
        tint: 'aisles',
        mobileColumns: 3,
      });
      expect(sec(doc, 'featured-collection')?.bgColor).not.toBe('token:inverse');
      expect(await row(m.storeId)).toMatchObject({ look: 'lamma.market', template: 'lamma' });

      await ok(m, 'lamma.table');
      doc = await draftOf(m.storeId);
      expect(sec(doc, 'featured-collection')).toMatchObject({ layout: 'menu' });
      expect(sec(doc, 'category-grid')?.tint).not.toBe('aisles');
      await awaitDeferredWork(5000);
    });

    it('Souq <-> Lamma and Qamar <-> Lamma switches keep the skin and the look in step', async () => {
      const m = await seedMerchant('lamma-cross');
      await ok(m, 'souq.night');
      await ok(m, 'lamma.market');
      expect(await row(m.storeId)).toMatchObject({ look: 'lamma.market', template: 'lamma' });
      await ok(m, 'qamar.atelier');
      expect(await row(m.storeId)).toMatchObject({ look: 'qamar.atelier', template: 'qamar' });
      await ok(m, 'lamma.notebook');
      expect(await row(m.storeId)).toMatchObject({ look: 'lamma.notebook', template: 'lamma' });
      expect(sec(await draftOf(m.storeId), 'maker-profile')?.variant).toBe('lead');
      await awaitDeferredWork(5000);
    });
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
