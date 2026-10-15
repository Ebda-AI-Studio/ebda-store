/**
 * Ruling LEGAL-4 tables under strict RLS, as the real `ebda_app` login:
 *   - legal_acceptances / legal_notice_deliveries are user-keyed: a user sees and writes only
 *     their own rows, a contextless read sees none;
 *   - legal_acceptances is append-only for ebda_app (UPDATE/DELETE revoked);
 *   - legal_notice_sends is platform-global (documented exception) and readable by any user;
 *   - deleting a user cascades to their legal rows, including a super-admin hard delete.
 * Raw SQL on purpose: it proves the DATABASE layer (the guard allows raw SQL under a scope).
 * The contextless read uses an UNGUARDED ebda_app client (as rls-ebda-app.test.ts does): the
 * guarded client throws TenantScopeViolation for user-keyed models, and RLS is what this proves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import {
  createPrismaClient,
  runWithRequestDb,
  withUser,
  asPlatformOperator,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 2 }), fn);

/** ebda_app WITHOUT the code-level tenant guard: RLS alone answers (same shape as rls-ebda-app). */
const makeUnguardedApp = (): AppPrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: appUrl(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
const asUnguardedApp = <T>(fn: () => Promise<T>) => runWithRequestDb(makeUnguardedApp, fn);

describe.skipIf(!hasDb)('legal tables under strict RLS', () => {
  let owner: AppPrismaClient;
  const users: Record<'a' | 'b' | 'op', string> = { a: '', b: '', op: '' };

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin') =>
    (
      await owner.user.create({
        data: {
          email: `ltr-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'L',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    users.a = await mkUser('a', 'store_admin');
    users.b = await mkUser('b', 'store_admin');
    users.op = await mkUser('op', 'super_admin');
    for (const userId of [users.a, users.b]) {
      await owner.legalAcceptance.create({
        data: { userId, docKey: 'terms', version: '1.0', source: 'signup' },
      });
      await owner.legalNoticeDelivery.create({
        data: { userId, docKey: 'terms', version: '1.0' },
      });
    }
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
    await owner.$disconnect();
  });

  for (const table of ['legal_acceptances', 'legal_notice_deliveries']) {
    it(`${table}: a user sees only their own rows; contextless sees none`, async () => {
      const seenByA = await asApp(() =>
        withUser(users.a, () =>
          prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
            `SELECT user_id FROM public."${table}" WHERE user_id IN ($1, $2)`,
            users.a,
            users.b
          )
        )
      );
      expect(seenByA.map(r => r.user_id)).toEqual([users.a]);
      const contextless = await asUnguardedApp(() =>
        prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM public."${table}"`)
      );
      expect(Number(contextless[0].n)).toBe(0);
    });

    it(`${table}: a user cannot write a row for someone else`, async () => {
      await expect(
        asApp(() =>
          withUser(users.a, () =>
            prisma.$executeRawUnsafe(
              `INSERT INTO public."${table}" (id, user_id, doc_key, version${
                table === 'legal_acceptances' ? ', source' : ', updated_at'
              }) VALUES ($1, $2, 'privacy', '1.0', ${
                table === 'legal_acceptances' ? "'signup'" : 'now()'
              })`,
              crypto.randomUUID(),
              users.b
            )
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });
  }

  it('legal_acceptances is append-only for ebda_app', async () => {
    await expect(
      asApp(() =>
        withUser(users.a, () =>
          prisma.$executeRawUnsafe(
            `UPDATE public.legal_acceptances SET version = '9.9' WHERE user_id = $1`,
            users.a
          )
        )
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it('legal_notice_sends is readable by any signed-in user (platform-global)', async () => {
    const docKey = 'legal';
    const version = `0.${run.replace(/\D/g, '').slice(0, 6) || '1'}`;
    await owner.legalNoticeSend.create({ data: { docKey, version, sentBy: users.op } });
    try {
      const rows = await asApp(() =>
        withUser(users.a, () =>
          prisma.legalNoticeSend.findMany({ where: { docKey, version }, select: { version: true } })
        )
      );
      expect(rows).toEqual([{ version }]);
    } finally {
      await owner.legalNoticeSend.deleteMany({ where: { docKey, version } });
    }
  });

  it('a super-admin hard delete of a user cascades to their legal rows', async () => {
    const victim = await mkUser('victim', 'store_admin');
    await owner.legalAcceptance.create({
      data: { userId: victim, docKey: 'terms', version: '1.0', source: 'signup' },
    });
    await asApp(() =>
      asPlatformOperator(users.op, () => prisma.user.delete({ where: { id: victim } }))
    );
    expect(await owner.legalAcceptance.count({ where: { userId: victim } })).toBe(0);
  });
});
