/**
 * Phase B5 Task 4 (Ruling B5-3): a legacy Dahab store (`template = 'dahab'`, `look = null`, the
 * retired night + gold theme stored, a published home with an `arch` tile list) moves through
 * Worn -> Workshop -> Gift box -> Worn with `design: 'keep'`, run the way production runs it: each
 * request bound to the guarded ebda_app client (tenant guard + strict RLS), the route mounted as
 * apps/api/src/routes/index.ts mounts it. Fixtures use the owner-role process `prisma`.
 *
 * The oracle is CONTENT IDENTITY at every step: product rows, personalisation configs, the logo,
 * the merchant's hero text (AR + EN) and the category photo never change; only design keys do.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { validateDefinitionSync, LOOK_OWNED_THEME_KEYS, sectionFromPreset } from '@ebda/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { hasDb } from '../helpers/bundle-fixtures';

// The Dahab looks are 'designed' until Task 6 flips them; the switch mechanics are proven on their
// real mixes either way, so they are presented as built here (the registry itself is untouched).
vi.mock('@ebda/shared', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/shared')>();
  return {
    ...real,
    getLook: (id: string | null | undefined) => {
      const look = real.getLook(id);
      return look && id?.startsWith('dahab.') ? { ...look, status: 'built' as const } : look;
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

/** The retired skin's stored theme: look-owned night/gold keys plus one non-look key. */
const NIGHT_THEME = {
  backgroundColor: '222 29% 8%',
  foregroundColor: '39 52% 90%',
  primaryColor: '39 49% 58%',
  showQuickAdd: true,
};

const PERSONALISATION = {
  enabled: true,
  label: 'Letters',
  labelAr: 'الحروف',
  maxLength: 12,
  required: true,
};

describe.skipIf(!hasDb)(
  'legacy Dahab store through the three new looks (ebda_app + tenant guard)',
  () => {
    let app: Express;
    let storeId: string;
    let token: string;
    let categoryId: string;
    const productIds: string[] = [];

    const put = (body: unknown) =>
      request(app)
        .put(`/api/v1/stores/${storeId}/look`)
        .set({ Authorization: `Bearer ${token}` })
        .send(body as object);
    const contentSnapshot = async () => {
      const products = await prisma.product.findMany({
        where: { storeId },
        orderBy: { slug: 'asc' },
        select: {
          slug: true,
          name: true,
          nameAr: true,
          price: true,
          personalisation: true,
          images: { select: { url: true }, orderBy: { url: 'asc' } },
        },
      });
      const cat = await prisma.category.findUniqueOrThrow({
        where: { id: categoryId },
        select: { slug: true, image: true, name: true, nameAr: true },
      });
      const store = await prisma.store.findUniqueOrThrow({
        where: { id: storeId },
        select: { name: true, nameAr: true, logo: true },
      });
      return { products, cat, store };
    };
    type Doc = {
      appliedLook?: string;
      sectionGroups: { header: { settings: Record<string, unknown> }[] };
      sections: {
        type: string;
        settings: Record<string, unknown>;
        blocks?: { settings: Record<string, unknown> }[];
      }[];
    };
    const latest = async (status: 'draft' | 'published') =>
      (await prisma.storePageRevision.findFirst({
        where: { storeId, pageKey: 'home', status },
        orderBy: { rev: 'desc' },
        select: { document: true },
      })) as { document: Doc } | null;
    const row = () =>
      prisma.store.findUniqueOrThrow({
        where: { id: storeId },
        select: { look: true, template: true, theme: true },
      });

    beforeAll(async () => {
      app = buildApp();
      await withRlsBypass(async tx => {
        const email = `dahab-legacy-${run}@test.local`;
        const user = await tx.user.create({
          data: {
            email,
            passwordHash: 'x',
            firstName: 'Dahab',
            lastName: 'Legacy',
            role: 'store_admin',
            emailVerified: true,
          },
        });
        const store = await tx.store.create({
          data: {
            name: `dahab-legacy-${run}`,
            nameAr: 'دهب القديم',
            slug: `dahab-legacy-${run}`,
            template: 'dahab',
            currency: 'EGP',
            ownerId: user.id,
            status: 'active',
            theme: NIGHT_THEME as object,
            logo: 'https://x/logo.webp',
          },
        });
        userIds.push(user.id);
        storeIds.push(store.id);
        storeId = store.id;
        token = jwt.sign({ userId: user.id, email, role: 'store_admin', tv: 0 }, config.jwtSecret, {
          expiresIn: '10m',
          issuer: 'ebda-api',
          audience: 'ebda-app',
        });
        const cat = await tx.category.create({
          data: {
            storeId,
            name: 'Rings',
            nameAr: 'خواتم',
            slug: 'rings',
            image: 'https://x/rings.webp',
          },
        });
        categoryId = cat.id;
        for (const [i, p] of [
          ['solitaire', 1875000, PERSONALISATION],
          ['chain', 980000, null],
        ] as const) {
          const prod = await tx.product.create({
            data: {
              storeId,
              name: `Piece ${p}`,
              nameAr: `قطعة ${i}`,
              slug: `${i}`,
              price: p,
              status: 'active',
              inventory: 5,
              ...(PERSONALISATION && i === 'solitaire'
                ? { personalisation: PERSONALISATION as object }
                : {}),
              images: { create: [{ url: `https://x/${i}.webp`, position: 0 }] },
            } as never,
          });
          productIds.push(prod.id);
        }
      });
    });

    afterAll(async () => {
      await withRlsBypass(async tx => {
        await tx.storePageRevision.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.product.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.category.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.store.deleteMany({ where: { id: { in: storeIds } } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      });
    });

    it('the legacy row is selected by the migration: template dahab, look null', async () => {
      const s = await row();
      expect(s).toMatchObject({ template: 'dahab', look: null });
      expect(
        await prisma.store.count({ where: { id: storeId, template: 'dahab', look: null } })
      ).toBe(1);
    });

    it('Worn: first switch publishes a home; then the merchant edits it (hero text AR+EN, an arch tile list)', async () => {
      const before = await contentSnapshot();
      const res = await put({ lookId: 'dahab.worn', design: 'keep' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await contentSnapshot()).toEqual(before);
      const s = await row();
      expect(s).toMatchObject({ look: 'dahab.worn', template: 'dahab' });
      // keep: the stored night keys stay as the merchant's overrides, the non-look key is untouched
      expect(s.theme).toEqual(NIGHT_THEME);

      const pub = await latest('published');
      expect(pub, 'an empty store gets a PUBLISHED home').toBeTruthy();
      const doc = pub!.document;
      // the merchant's own hero words and a legacy arch tile list, written straight into the published document
      const hero = doc.sections.find(x => x.type === 'hero')!;
      hero.blocks = [
        {
          id: 's1',
          type: 'slide',
          settings: {
            image: 'https://x/hero.webp',
            headline: 'Gold you live in',
            headlineAr: 'دهب يتلبس كل يوم',
          },
        },
      ] as never;
      const header = sectionFromPreset('header', 0, 'hdr');
      header.settings = { ...header.settings, logo: 'https://x/logo.webp' };
      doc.sectionGroups.header = [header] as never;
      doc.sections.push({
        type: 'collection-list',
        id: 'legacy-tiles',
        settings: { tileShape: 'arch', headingAr: 'مجموعاتنا' },
        blocks: [
          {
            id: 'c1',
            type: 'collection',
            settings: { categorySlug: 'rings', image: 'https://x/rings.webp' },
          },
        ],
      } as never);
      await prisma.storePageRevision.updateMany({
        where: { storeId, pageKey: 'home', status: 'published' },
        data: { document: doc as object },
      });
      // a saved document with tileShape 'arch' still validates (Ruling B5-3)
      const v = validateDefinitionSync(doc);
      expect(v.ok, JSON.stringify((v as { errors?: unknown }).errors)).toBe(true);
    });

    it('Worn -> Workshop -> Gift box -> Worn: content identical at every step, only design keys change', async () => {
      const baseline = await contentSnapshot();
      let from = 'dahab.worn';
      for (const lookId of ['dahab.workshop', 'dahab.giftbox', 'dahab.worn']) {
        const res = await put({ lookId, design: 'keep' });
        expect(res.status, `${from} -> ${lookId}: ${JSON.stringify(res.body)}`).toBe(200);
        // a store with a published home gets a DRAFT; the live page is never touched by a switch
        expect(res.body.data.builder).toBe('draft');
        expect(await contentSnapshot(), `${from} -> ${lookId}`).toEqual(baseline);
        const s = await row();
        expect(s.look).toBe(lookId);
        expect(s.theme).toEqual(NIGHT_THEME);
        const draft = (await latest('draft'))!.document;
        const hero = draft.sections.find(x => x.type === 'hero')!;
        expect(hero.blocks?.[0]?.settings, `${lookId} hero`).toMatchObject({
          headline: 'Gold you live in',
          headlineAr: 'دهب يتلبس كل يوم',
        });
        expect(draft.sectionGroups.header[0].settings.logo).toBe('https://x/logo.webp');
        const tiles = draft.sections.find(x => x.id === 'legacy-tiles');
        expect(tiles?.blocks?.[0]?.settings, `${lookId} tiles`).toMatchObject({
          categorySlug: 'rings',
          image: 'https://x/rings.webp',
        });
        const v = validateDefinitionSync(draft);
        expect(v.ok, `${lookId}: ${JSON.stringify((v as { errors?: unknown }).errors)}`).toBe(true);
        from = lookId;
      }
      // the published page is still the one written before the switches
      const pub = (await latest('published'))!.document;
      expect(pub.sections.find(x => x.id === 'legacy-tiles')?.settings.tileShape).toBe('arch');
    });

    it('reset: the old night/gold look-owned keys are gone, a non-look key stays', async () => {
      const res = await put({ lookId: 'dahab.workshop', design: 'reset' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const s = await row();
      expect(s.theme).toEqual({ showQuickAdd: true });
      for (const k of Object.keys(NIGHT_THEME))
        if ((LOOK_OWNED_THEME_KEYS as readonly string[]).includes(k))
          expect(s.theme).not.toHaveProperty(k);
    });
  }
);
