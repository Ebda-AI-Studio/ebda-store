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
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import {
  builtLookTemplates,
  defaultNewStoreLook,
  getLook,
  LOOKS,
  TEMPLATE_FAMILIES,
  validatePublishReadiness,
} from '@ebda/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import onboardingRoutes from '@api/routes/onboarding.routes';
import { errorHandler, AppError } from '@api/middleware/error-handler';
import { StoreService } from '@api/services/store.service';
import { config } from '@api/config';
import { hasDb } from '../helpers/bundle-fixtures';
import { safeRun } from '../helpers/safe-run';

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

const run = safeRun();
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
    issuer: 'ebda-api',
    audience: 'ebda-app',
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

  // Only BUILT templates are offered to a new store (#111): an unbuilt look is refused below.
  it.each(builtLookTemplates().map(t => [t, letterA(t)] as const))(
    '%s: a fresh store lands on a PUBLISHED, publish-ready home of that family (%s)',
    async (template, lookId) => {
      const m = await merchant(`fam${template}`);
      const res = await create(m.token, {
        name: 'Fam Shop',
        slug: mkSlug(`fam${builtLookTemplates().indexOf(template)}`),
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
      // A look with its own section mix composes that mix instead of the family's (Ruling B1-3).
      const mix = getLook(lookId)!.sections?.map(s => s.type) ?? [];
      const allowed = mix.length > 0 ? mix : family.sectionTypes;
      expect(types.length).toBeGreaterThan(0);
      for (const t of types) expect(allowed).toContain(t);
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
        lookId: defaultNewStoreLook().id,
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

  it('an unbuilt (designed) look is refused with a 400 and creates no store (#111)', async () => {
    // Every registry look is built today (Dahab/B5, #151 flipped the last one), so the refusal would
    // go untested. Use a real designed look when one exists, else register a synthetic one for this
    // test only (same module instance the API reads) and remove it again.
    const registry = LOOKS as unknown as Array<(typeof LOOKS)[number]>;
    let designed = registry.find(l => l.status !== 'built');
    const synthetic = designed
      ? null
      : { ...registry[0], id: 'test.designed-only', status: 'designed' as const };
    if (synthetic) {
      registry.push(synthetic);
      designed = synthetic;
    }
    try {
      expect(designed!.status).not.toBe('built');
      const m = await merchant('unbuilt');
      const slug = mkSlug('unbuilt');
      const res = await create(m.token, { name: 'Unbuilt', slug, lookId: designed!.id });
      expect(res.status).toBe(400);
      // The request schema refuses it first (VALIDATION_ERROR); the service re-checks (LOOK_NOT_AVAILABLE).
      expect(JSON.stringify(res.body)).toContain('not available for new stores');
      expect(await prisma.store.count({ where: { slug } })).toBe(0);
    } finally {
      if (synthetic) registry.splice(registry.indexOf(synthetic), 1);
    }
  });

  it('no lookId starts the store on the registry default look, never the DB default (#111)', async () => {
    const m = await merchant('legacy');
    const res = await create(m.token, { name: 'Legacy', slug: mkSlug('legacy') });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await prisma.store.findUniqueOrThrow({
      where: { id: res.body.data.store.id },
      select: { look: true, template: true },
    });
    expect(row.look).toBe(defaultNewStoreLook().id);
    expect(row.template).toBe(defaultNewStoreLook().skin);
  });
});
