/**
 * Staff invitations on a REAL Postgres, as the strict-RLS role `ebda_app` (Ruling ID-13).
 *   - SEAT RACE: N invitees accept at the same moment for ONE free seat -> exactly one succeeds, the store ends with
 *     exactly maxStaff members (the FOR UPDATE on the store row + the count inside the transaction).
 *   - A used link cannot be replayed, a removed member cannot re-enter with the same link, a revoked link fails.
 * Identity, Redis and the feature flag are stubbed (they are other services); everything else is the real route, the real
 * guarded Prisma client and the real policies. Owner-role `prisma` is used only for fixtures and read-backs.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb, withStore } from '@ebda/database';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const accounts = vi.hoisted(() => new Map<string, { email: string }>());
vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: String(req.headers['x-test-user']), role: 'staff' } as never;
    next();
  },
  rejectImpersonated: (_q: Request, _r: Response, n: NextFunction) => n(),
}));
vi.mock('../../apps/api/src/lib/identity-client', () => ({
  getAccountState: async (id: string) => ({
    id,
    email: accounts.get(id)?.email,
    role: 'staff',
    status: 'active',
    emailVerified: true,
  }),
  setAccountRole: async () => true,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { acquireLock: async () => true, releaseLock: async () => undefined },
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('../../apps/api/src/middleware/security', () => ({ auditLog: async () => undefined }));

const { default: inviteRoutes } = await import('../../apps/api/src/routes/staff-invite.routes');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { signStaffInviteToken } = await import('../../apps/api/src/lib/staff-invite-token');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    runWithRequestDb(
      () => createPrismaClient({ connectionString: appUrl(), max: 4 }),
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/staff-invites', inviteRoutes);
  app.use(errorHandler);
  return app;
}

const created = { storeIds: [] as string[], userIds: [] as string[], planCodes: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 10);

/** A store on a plan with `seats` staff seats, `n` invitees each holding their own pending invitation. */
async function seed(seats: number, n: number) {
  const tag = uid();
  // The seeded 'basic' plan, not the lowest sort: other files leave sort-0 grant plans behind whose partial limits would
  // fail plans.limits validation and silently fall back to the seed (1 seat), voiding the seat count under test.
  const base = await prisma.plan.findUnique({ where: { code: 'basic' } });
  const planCode = `seat-test-${tag}`;
  await prisma.plan.create({
    data: {
      code: planCode,
      nameEn: planCode,
      nameAr: planCode,
      limits: { ...((base?.limits as object) ?? {}), maxStaff: seats },
    },
  });
  created.planCodes.push(planCode);
  const owner = await prisma.user.create({
    data: {
      email: `owner-${tag}@test.local`,
      passwordHash: 'x',
      firstName: 'O',
      lastName: 'W',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `seat ${tag}`,
      slug: `seat-${tag}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  await prisma.storeSubscription.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id, planCode, status: 'active' },
    update: { planCode, status: 'active' },
  });
  const invitees: Array<{ id: string; token: string; inviteId: string }> = [];
  for (let i = 0; i < n; i++) {
    const email = `inv-${tag}-${i}@test.local`;
    const u = await prisma.user.create({
      data: {
        email,
        passwordHash: '!identity',
        firstName: 'I',
        lastName: String(i),
        role: 'staff',
        status: 'active',
        emailVerified: true,
      },
    });
    created.userIds.push(u.id);
    accounts.set(u.id, { email });
    const inviteId = crypto.randomUUID();
    await prisma.staffInvite.create({
      data: {
        id: inviteId,
        storeId: store.id,
        email,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    invitees.push({
      id: u.id,
      inviteId,
      token: signStaffInviteToken({ email, storeId: store.id, jti: inviteId }),
    });
  }
  return { storeId: store.id, invitees };
}

const accept = (app: Express, userId: string, token: string) =>
  request(app).post('/api/v1/staff-invites/accept').set('x-test-user', userId).send({ token });
const members = (storeId: string) => prisma.storeStaff.count({ where: { storeId } });

afterAll(async () => {
  if (!hasDb) return;
  await prisma.staffInvite.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.storeStaff.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.storeSubscription.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.plan.deleteMany({ where: { code: { in: created.planCodes } } });
});

describe.skipIf(!hasDb)('staff invitations on ebda_app (strict RLS, real locks)', () => {
  it('SEAT RACE: 8 simultaneous accepts for the LAST seat -> exactly one member', async () => {
    const app = buildApp();
    const { storeId, invitees } = await seed(1, 8);
    const res = await Promise.all(invitees.map(i => accept(app, i.id, i.token)));
    const ok = res.filter(r => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(res.filter(r => r.status !== 200).every(r => r.status === 402)).toBe(true);
    expect(await members(storeId)).toBe(1);
    // the losers' invitations were not consumed (their transaction rolled back)
    const pending = await prisma.staffInvite.count({ where: { storeId, status: 'pending' } });
    expect(pending).toBe(7);
  });

  it('SEAT RACE: 6 simultaneous accepts for 2 free seats -> exactly two members', async () => {
    const app = buildApp();
    const { storeId, invitees } = await seed(2, 6);
    const res = await Promise.all(invitees.map(i => accept(app, i.id, i.token)));
    expect(res.filter(r => r.status === 200)).toHaveLength(2);
    expect(await members(storeId)).toBe(2);
  });

  it('a used link cannot be replayed, and a removed member cannot re-enter with it', async () => {
    const app = buildApp();
    const { storeId, invitees } = await seed(3, 1);
    const [a] = invitees;
    expect((await accept(app, a.id, a.token)).status).toBe(200);
    // the owner removes the member
    await prisma.storeStaff.deleteMany({ where: { storeId, userId: a.id } });
    const again = await accept(app, a.id, a.token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVITE_INVALID');
    expect(await members(storeId)).toBe(0);
  });

  it('a revoked link fails', async () => {
    const app = buildApp();
    const { storeId, invitees } = await seed(3, 1);
    const [a] = invitees;
    await prisma.staffInvite.update({ where: { id: a.inviteId }, data: { status: 'revoked' } });
    expect((await accept(app, a.id, a.token)).status).toBe(400);
    expect(await members(storeId)).toBe(0);
  });

  it('RLS: the app role sees only its own store invitations', async () => {
    const one = await seed(1, 1);
    const two = await seed(1, 1);
    // The tenant guard refuses a raw statement on a tenant table with no scope, so the read runs inside withStore(one): the
    // app role (no BYPASSRLS) must still see only that store's rows. The service wrapper sets the GUC; the policy does the filtering.
    const rows = await runWithRequestDb(
      () => createPrismaClient({ connectionString: appUrl(), max: 2 }),
      () =>
        withStore(
          one.storeId,
          tx => tx.$queryRaw<Array<{ store_id: string }>>`SELECT store_id FROM staff_invites`
        )
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.store_id === one.storeId)).toBe(true);
    expect(rows.some(r => r.store_id === two.storeId)).toBe(false);
  });
});
