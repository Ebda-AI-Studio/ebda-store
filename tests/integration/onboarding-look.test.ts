/**
 * POST /onboarding/store with `lookId`: the new store comes out wearing that look (look + skin
 * template set, home page published with the look's template-family sections). Run the way
 * production runs it: onboarding has NO ambient tenant context, each request is bound to the
 * guarded ebda_app client (code-level tenant guard + strict RLS), fixtures use the owner-role
 * process `prisma`.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, createPrismaClient, runWithRequestDb } from '@force/database';
import {
  getLook,
  LOOKS,
  LOOK_TEMPLATES,
  TEMPLATE_FAMILIES,
  validatePublishReadiness,
} from '@force/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import onboardingRoutes from '@api/routes/onboarding.routes';
import { errorHandler, AppError } from '@api/middleware/error-handler';
import { StoreService } from '@api/services/store.service';
import { config } from '@api/config';
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
const slugs: string[] = [];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/onboarding', onboardingRoutes);
  app.use(errorHandler);
  return app;
}

async function merchant(tag: string) {
  const email = `ob-look-${tag}-${run}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      firstName: 'Look',
      lastName: tag,
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userIds.push(user.id);
  const token = jwt.sign({ userId: user.id, email, role: 'store_admin', tv: 0 }, config.jwtSecret, {
    expiresIn: '10m',
    issuer: 'force-api',
    audience: 'force-app',
  });
  return { userId: user.id, token };
}

describe.skipIf(!hasDb)('POST /onboarding/store with a look (ebda_app + tenant guard)', () => {
  const app = buildApp();
  const create = (token: string, body: Record<string, unknown>) =>
    request(app)
      .post('/api/v1/onboarding/store')
      .set({ Authorization: `Bearer ${token}` })
      .send(body);
  const mkSlug = (tag: string) => {
    const s = `ob-look-${tag}-${run}`;
    slugs.push(s);
    return s;
  };

  afterAll(async () => {
    const stores = await prisma.store.findMany({
      where: { slug: { in: slugs } },
      select: { id: true },
    });
    const ids = stores.map(s => s.id);
    await prisma.storePageRevision.deleteMany({ where: { storeId: { in: ids } } });
    await prisma.store.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const letterA = (template: string) =>
    LOOKS.find(l => l.template === template && l.letter === 'A')!.id;

  it.each(LOOK_TEMPLATES.map(t => [t, letterA(t)] as const))(
    '%s: a fresh store lands on a PUBLISHED, publish-ready home of that family (%s)',
    async (template, lookId) => {
      const m = await merchant(`fam${template}`);
      const res = await create(m.token, {
        name: 'Fam Shop',
        slug: mkSlug(`fam${LOOK_TEMPLATES.indexOf(template)}`),
        lookId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.lookApplied).toBe(true);
      const id = res.body.data.store.id as string;
      await awaitDeferredWork(5000);
      const row = await prisma.store.findUniqueOrThrow({
        where: { id },
        select: { look: true, template: true },
      });
      expect(row.look).toBe(lookId);
      expect(row.template).toBe(getLook(lookId)!.skin);
      const revs = await prisma.storePageRevision.findMany({ where: { storeId: id } });
      expect(revs.map(r => r.status)).toEqual(['published']);
      const doc = revs[0]!.document as { sections?: { type: string }[] };
      const types = (doc.sections ?? []).map(s => s.type);
      const family = TEMPLATE_FAMILIES.find(f => f.id === template)!;
      expect(types.length).toBeGreaterThan(0);
      for (const t of types) expect(family.sectionTypes).toContain(t);
      expect(validatePublishReadiness(doc as never)).toEqual([]);
    }
  );

  it('a look that fails to apply is reported as lookApplied:false and the store is still created', async () => {
    const m = await merchant('fail');
    const spy = vi
      .spyOn(StoreService, 'applyLook')
      .mockRejectedValueOnce(new AppError(422, 'INVALID_DEFINITION', 'nope'));
    try {
      const res = await create(m.token, {
        name: 'Fail',
        slug: mkSlug('fail'),
        lookId: 'dahab.worn',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.lookApplied).toBe(false);
      const row = await prisma.store.findUniqueOrThrow({
        where: { id: res.body.data.store.id },
        select: { look: true },
      });
      expect(row.look).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('an unknown lookId is a 400 and creates no store', async () => {
    const m = await merchant('bad');
    const slug = mkSlug('bad');
    const res = await create(m.token, { name: 'Bad', slug, lookId: 'nope.nothing' });
    expect(res.status).toBe(400);
    expect(await prisma.store.count({ where: { slug } })).toBe(0);
  });

  it('no lookId keeps the legacy behaviour (look stays null)', async () => {
    const m = await merchant('legacy');
    const res = await create(m.token, { name: 'Legacy', slug: mkSlug('legacy') });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await prisma.store.findUniqueOrThrow({
      where: { id: res.body.data.store.id },
      select: { look: true },
    });
    expect(row.look).toBeNull();
  });
});
