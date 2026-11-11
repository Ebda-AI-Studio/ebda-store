/**
 * SP5 task 4 - slug squatting and store-creation velocity, against a real
 * Postgres: protected brand names are refused with SLUG_PROTECTED (normalised),
 * a super_admin can override, and one account may create at most
 * STORES_PER_ACCOUNT_PER_DAY stores per rolling day (soft-deleted ones count).
 *
 * Mutation proofs (recorded in the commit body):
 *   1. services/onboarding.service.ts: drop the `allowProtected` pass-through
 *      (always pass false) -> "super_admin can claim a protected name" fails.
 *   2. services/store-creation-limit.ts: filter `deletedAt: null` in the count
 *      -> "a soft-deleted store still counts toward the daily cap" fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from '@ebda/database';
import { config } from '@api/config';
import onboardingRoutes from '@api/routes/onboarding.routes';
import { redis } from '@api/services/redis.service';
import { planService } from '@api/services/plan.service';
import { errorHandler } from '@api/middleware/error-handler';
import { hasDb } from '../helpers/bundle-fixtures';
import { safeRun } from '../helpers/safe-run';

// safeRun, not hex: a hex suffix can normalise into a protected brand and the create answers 400 SLUG_PROTECTED
// (PR #703's run: 400 instead of 429, same class as 3b34aae6e)
const run = safeRun();
const userIds: string[] = [];

function token(userId: string, role: 'store_admin' | 'super_admin') {
  return jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });
}

// `uniq` per call: CI's --retry=1 re-runs a test with the same `run`, and a fixed email collided (P2002)
let uniq = 0;
async function mkUser(tag: string, role: 'store_admin' | 'super_admin' = 'store_admin') {
  const u = await prisma.user.create({
    data: {
      email: `abuse-${tag}-${run}-${++uniq}@test.local`,
      passwordHash: 'x',
      firstName: 'Abuse',
      lastName: tag,
      role,
      storeId: null,
      emailVerified: true,
    },
    select: { id: true },
  });
  userIds.push(u.id);
  return { id: u.id, jwt: token(u.id, role) };
}

/**
 * Locked pricing: a SECOND store needs a plan with maxStores > 1 (Business = 3), so these
 * velocity tests first move the owner's first store onto Business, then exercise the daily cap.
 */
async function upgradeToBusiness(storeId: string) {
  await planService.assignPlan(storeId, { planCode: 'business' });
}

describe.skipIf(!hasDb)('self-serve abuse: slug squatting + store velocity', () => {
  let app: Express;
  // The shared writeLimiter (30/min) is real here; this suite is not testing it.
  const bearer = (jwtStr: string) => ({
    Authorization: `Bearer ${jwtStr}`,
    'x-load-test-token': 'abuse-suite',
  });
  const post = (jwtStr: string, slug: string, name = 'Shop') =>
    request(app).post('/api/v1/onboarding/store').set(bearer(jwtStr)).send({ name, slug });

  beforeAll(async () => {
    process.env.STORES_PER_ACCOUNT_PER_DAY = '2';
    process.env.LOAD_TEST_BYPASS_TOKEN = 'abuse-suite';
    await redis.connect();
    app = express();
    app.use(express.json());
    app.use('/api/v1/onboarding', onboardingRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    delete process.env.STORES_PER_ACCOUNT_PER_DAY;
    delete process.env.LOAD_TEST_BYPASS_TOKEN;
    await prisma.store.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await redis.disconnect();
  });

  describe('protected names', () => {
    it('slug-check and create refuse a protected brand with SLUG_PROTECTED', async () => {
      const m = await mkUser('prot');
      const check = await request(app)
        .get('/api/v1/onboarding/slug-check?slug=paymob')
        .set(bearer(m.jwt));
      expect(check.status).toBe(200);
      expect(check.body.data).toMatchObject({ available: false, reason: 'SLUG_PROTECTED' });
      expect(check.body.data.message).toMatch(/contact support/i);

      const created = await post(m.jwt, 'paymob');
      expect(created.status).toBe(400);
      expect(created.body.error.code).toBe('SLUG_PROTECTED');
      expect(await prisma.store.count({ where: { ownerId: m.id } })).toBe(0);
    });

    it.each(['ebda-support', 'vodafone-cash', 'p4ym0b', 'f4wry', 'official-fawry'])(
      'refuses the confusable %s',
      async slug => {
        const m = await mkUser(`conf-${slug.slice(0, 4)}`);
        const res = await post(m.jwt, slug);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('SLUG_PROTECTED');
      }
    );

    it('an ordinary slug is unaffected', async () => {
      const m = await mkUser('ok');
      const res = await post(m.jwt, `plain-shop-${run}`);
      expect(res.status).toBe(201);
    });

    it('super_admin can claim a protected name (support override)', async () => {
      const sa = await mkUser('sa', 'super_admin');
      const slug = `ebda-shop-${run}`;
      const res = await post(sa.jwt, slug);
      expect(res.status).toBe(201);
      expect(res.body.data.store.slug).toBe(slug);
    });

    it('reserved labels are never overridable, even for super_admin', async () => {
      const sa = await mkUser('sa2', 'super_admin');
      const res = await post(sa.jwt, 'api');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SLUG_RESERVED');
    });
  });

  describe('per-account daily store cap', () => {
    it('allows STORES_PER_ACCOUNT_PER_DAY then refuses with STORE_DAILY_LIMIT', async () => {
      const m = await mkUser('cap');
      const first = await post(m.jwt, `cap-a-${run}`);
      expect(first.status).toBe(201);
      await upgradeToBusiness(first.body.data.store.id);
      expect((await post(m.jwt, `cap-b-${run}`)).status).toBe(201);
      const third = await post(m.jwt, `cap-c-${run}`);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('STORE_DAILY_LIMIT');
      expect(await prisma.store.count({ where: { ownerId: m.id } })).toBe(2);
    });

    it('a soft-deleted store still counts toward the daily cap', async () => {
      const m = await mkUser('capdel');
      const a = await post(m.jwt, `del-a-${run}`);
      expect(a.status).toBe(201);
      await upgradeToBusiness(a.body.data.store.id);
      expect((await post(m.jwt, `del-b-${run}`)).status).toBe(201);
      await prisma.store.update({
        where: { id: a.body.data.store.id },
        data: { deletedAt: new Date() },
      });
      const again = await post(m.jwt, `del-c-${run}`);
      expect(again.status).toBe(429);
      expect(again.body.error.code).toBe('STORE_DAILY_LIMIT');
    });

    it('the window rolls: stores older than 24h no longer count', async () => {
      const m = await mkUser('roll');
      const a = await post(m.jwt, `roll-a-${run}`);
      await upgradeToBusiness(a.body.data.store.id);
      const b = await post(m.jwt, `roll-b-${run}`);
      expect([a.status, b.status]).toEqual([201, 201]);
      await prisma.store.updateMany({
        where: { ownerId: m.id },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      expect((await post(m.jwt, `roll-c-${run}`)).status).toBe(201);
    });

    it("another account's budget is independent", async () => {
      const x = await mkUser('indx');
      const y = await mkUser('indy');
      const xa = await post(x.jwt, `ind-a-${run}`);
      await upgradeToBusiness(xa.body.data.store.id);
      await post(x.jwt, `ind-b-${run}`);
      expect((await post(x.jwt, `ind-c-${run}`)).status).toBe(429);
      expect((await post(y.jwt, `ind-d-${run}`)).status).toBe(201);
    });

    it('a parallel burst cannot slip past the cap', async () => {
      const m = await mkUser('burst');
      // One Business store already exists today, so the burst competes for the ONE remaining slot.
      const seed = await post(m.jwt, `burst-seed-${run}`);
      await upgradeToBusiness(seed.body.data.store.id);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => post(m.jwt, `burst-${i}-${run}`))
      );
      const created = results.filter(r => r.status === 201).length;
      expect(created).toBeLessThanOrEqual(1);
      expect(await prisma.store.count({ where: { ownerId: m.id } })).toBeLessThanOrEqual(2);
    });
  });
});
