/**
 * Ruling PASSKEY-1 table `passkey_credentials` as the real `ebda_app` login, plus the recovery rule
 * (PASSKEY-10): user-keyed strict RLS (own rows only; contextless sees none; no write for someone else),
 * the unguarded credential lookup returns public material only, the erase definer is guarded, the user
 * FK cascades, and a password reset removes every passkey.
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
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import { AuthService } from '@api/services/auth.service';
import { configureIdentityClient } from '@api/lib/identity-client';

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
const makeUnguardedApp = (): AppPrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: appUrl(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
const asUnguardedApp = <T>(fn: () => Promise<T>) => runWithRequestDb(makeUnguardedApp, fn);

const insertSql = `INSERT INTO public.passkey_credentials
  (id, user_id, credential_id, public_key, device_type, rp_id, name)
  VALUES ($1, $2, $3, 'pk', 'multiDevice', 'admin.ebda.app', 'phone')`;

describe.skipIf(!hasDb)('passkey_credentials under strict RLS', () => {
  let owner: AppPrismaClient;
  const u: Record<'a' | 'b' | 'root', string> = { a: '', b: '', root: '' };
  const cred = (tag: string) => `cred-${tag}-${run}`;

  const mk = async (tag: string, role: 'store_admin' | 'super_admin' = 'store_admin') =>
    (
      await owner.user.create({
        data: {
          email: `pk-${tag}-${run}@test.local`,
          passwordHash: 'x',
          firstName: 'P',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    u.a = await mk('a');
    u.b = await mk('b');
    u.root = await mk('root', 'super_admin');
    for (const [tag, id] of [
      ['a', u.a],
      ['b', u.b],
    ] as const) {
      await owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), id, cred(tag));
    }
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { id: { in: Object.values(u).filter(Boolean) } } });
    await owner.$disconnect();
  });

  it('a user sees only their own passkeys; contextless sees none; even a super_admin sees none of others', async () => {
    const seenByA = await asApp(() =>
      withUser(u.a, () =>
        prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
          `SELECT user_id FROM public.passkey_credentials WHERE user_id IN ($1, $2)`,
          u.a,
          u.b
        )
      )
    );
    expect(seenByA.map(r => r.user_id)).toEqual([u.a]);
    const seenByRoot = await asApp(() =>
      withUser(u.root, () =>
        prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM public.passkey_credentials WHERE user_id IN ($1, $2)`,
          u.a,
          u.b
        )
      )
    );
    expect(Number(seenByRoot[0].n)).toBe(0);
    const contextless = await asUnguardedApp(() =>
      prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM public.passkey_credentials`
      )
    );
    expect(Number(contextless[0].n)).toBe(0);
  });

  it('a user cannot add, rewrite or delete a passkey belonging to someone else', async () => {
    await expect(
      asApp(() =>
        withUser(u.a, () =>
          prisma.$executeRawUnsafe(insertSql, crypto.randomUUID(), u.b, cred('forged'))
        )
      )
    ).rejects.toThrow(/row-level security/i);
    const touched = await asApp(() =>
      withUser(u.a, async () => ({
        upd: await prisma.$executeRawUnsafe(
          `UPDATE public.passkey_credentials SET name = 'hijack' WHERE user_id = $1`,
          u.b
        ),
        del: await prisma.$executeRawUnsafe(
          `DELETE FROM public.passkey_credentials WHERE user_id = $1`,
          u.b
        ),
      }))
    );
    expect(touched).toEqual({ upd: 0, del: 0 });
    const still = await owner.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM public.passkey_credentials WHERE user_id = $1`,
      u.b
    );
    expect(still.map(r => r.name)).toEqual(['phone']);
  });

  it('credential ids are globally unique', async () => {
    await expect(
      owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), u.b, cred('a'))
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('the credential lookup works with NO user context and returns public material only', async () => {
    const rows = await asUnguardedApp(() =>
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM public.ebda_passkey_lookup($1)`,
        cred('a')
      )
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'counter',
      'id',
      'public_key',
      'rp_id',
      'transports',
      'user_id',
    ]);
    expect(rows[0].user_id).toBe(u.a);
    expect(
      await asUnguardedApp(() =>
        prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM public.ebda_passkey_lookup($1)`, 'nope')
      )
    ).toEqual([]);
  });

  it('the erase definer is guarded: another user may not call it, the user themself may', async () => {
    await expect(
      asApp(() =>
        withUser(u.b, () => prisma.$queryRawUnsafe(`SELECT public.ebda_passkeys_delete($1)`, u.a))
      )
    ).rejects.toThrow(/may not act on user/i);
    const n = await asApp(() =>
      withUser(u.a, () =>
        prisma.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT public.ebda_passkeys_delete($1) AS n`,
          u.a
        )
      )
    );
    expect(Number(n[0].n)).toBe(1);
  });

  it('deleting the user cascades to their passkeys', async () => {
    const victim = await mk('victim');
    await owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), victim, cred('victim'));
    await owner.user.delete({ where: { id: victim } });
    const left = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM public.passkey_credentials WHERE credential_id = $1`,
      cred('victim')
    );
    expect(Number(left[0].n)).toBe(0);
  });

  it('a password reset removes every passkey of that user and only theirs (PASSKEY-10)', async () => {
    const who = await mk('reset');
    const bystander = await mk('bystander');
    await owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), who, cred('reset1'));
    await owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), who, cred('reset2'));
    await owner.$executeRawUnsafe(insertSql, crypto.randomUUID(), bystander, cred('by'));
    const raw = crypto.randomBytes(32).toString('hex');
    // `who` is an admin-namespace account, so the reset also asks the identity service to end its sessions; that service
    // (accounts) is not in this tier, a no-op stands in (its revocation is covered by apps/accounts/test/rpc.test.ts).
    configureIdentityClient({ revokeUser: async () => undefined });
    await prisma.refreshToken.create({
      data: {
        token: `reset:${crypto.createHash('sha256').update(raw).digest('hex')}`,
        userId: who,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    try {
      await AuthService.resetPassword(raw, 'BrandNew!2345');
    } finally {
      configureIdentityClient(undefined);
    }
    const count = async (id: string) =>
      Number(
        (
          await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*) AS n FROM public.passkey_credentials WHERE user_id = $1`,
            id
          )
        )[0].n
      );
    expect(await count(who)).toBe(0);
    expect(await count(bystander)).toBe(1);
    await owner.user.deleteMany({ where: { id: { in: [who, bystander] } } });
  });
});
