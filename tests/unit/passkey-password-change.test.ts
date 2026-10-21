/**
 * Review I1 (Ruling PASSKEY-13): a password CHANGE removes every passkey, like a reset. Scenario: an
 * attacker holding the owner's password and a session steps up and registers their own passkey; the owner
 * (told by the "added" email) changes the password. The attacker's session dies - and so must their passkey.
 * Real AuthService.changePassword + real PasskeyService; Redis, the database and the mailer are fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { register, assert } from '../helpers/software-authenticator';

const ADMIN = 'https://admin.ebda.app';
type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  creds: [] as Row[],
  users: new Map<string, Row>(),
  mails: [] as Row[],
  audits: [] as Row[],
  hash: { v: '' },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      setex: async (k: string, _t: number, v: string) => void h.redis.set(k, v),
      get: async (k: string) => h.redis.get(k) ?? null,
      del: async (k: string) => (h.redis.delete(k) ? 1 : 0),
    }),
    isAvailable: () => false,
  },
}));
vi.mock('@api/lib/definer', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/lib/definer')>();
  return {
    ...actual,
    lookupStore: async () => null,
    passkeyLookup: async (id: string) => h.creds.find(c => c.credentialId === id) ?? null,
    insertAuditLog: async (e: Row) => void h.audits.push(e),
  };
});
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  const tx = {
    user: {
      findUnique: async ({ where }: any) => h.users.get(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(h.users.get(where.id)!, data),
    },
    passkeyCredential: {
      findMany: async ({ where }: any) => h.creds.filter(c => c.userId === where.userId),
      create: async ({ data }: any) => {
        const row = {
          id: `pk-${h.creds.length + 1}`,
          createdAt: new Date(),
          lastUsedAt: null,
          ...data,
        };
        h.creds.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = h.creds.filter(c => c.id === where.id && c.userId === where.userId);
        hits.forEach(c => Object.assign(c, data));
        return { count: hits.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = h.creds.length;
        h.creds = h.creds.filter(c => c.userId !== where.userId);
        return { count: before - h.creds.length };
      },
    },
  };
  return { ...actual, withUser: async (_i: string, fn: any) => fn(tx), prisma: {} };
});
vi.mock('@api/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      adminUrl: 'https://admin.ebda.app',
      webUrl: 'https://ebda.app',
      nodeEnv: 'production',
    },
  };
});
vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: async () => ({ locked: false }),
    recordFailedAttempt: async () => ({ locked: false }),
    recordSuccessfulLogin: async () => undefined,
  },
}));
vi.mock('@api/services/platform-mailer', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/services/platform-mailer')>();
  return { ...actual, sendPasskeyNoticeEmail: async (d: Row) => void h.mails.push(d) };
});
vi.mock('@api/services/encryption.service', () => ({ encryption: { decrypt: (s: string) => s } }));

import { AuthService } from '@api/services/auth.service';
import { PasskeyService } from '@api/services/passkey.service';
import { passkeyNoticeTemplate } from '@api/services/email-templates/passkey-notice';

const OLD = 'Old-pw-1!aaa';
const NEW = 'New-pw-2!bbb';

beforeEach(() => {
  h.redis.clear();
  h.creds = [];
  h.mails = [];
  h.audits = [];
  h.hash.v ||= bcrypt.hashSync(OLD, 4);
  h.users = new Map([
    [
      'owner',
      {
        id: 'owner',
        email: 'o@x.com',
        firstName: 'Mona',
        lastName: 'S',
        language: 'ar',
        role: 'store_admin',
        storeId: null,
        status: 'active',
        deletedAt: null,
        emailVerified: true,
        tokenVersion: 0,
        mfaEnabled: false,
        mfaSecret: null,
        passwordHash: h.hash.v,
      },
    ],
  ]);
  vi.spyOn(AuthService, 'revokeAllSessions').mockResolvedValue(undefined);
});

async function attackerRegisters() {
  const actor = { userId: 'owner', sessionId: 'attacker-session' };
  await PasskeyService.markStepUp('owner', 'attacker-session');
  const options: any = await PasskeyService.beginRegistration(actor, ADMIN);
  const { credential, response } = register(options, ADMIN);
  await PasskeyService.finishRegistration(actor, ADMIN, { response, name: 'attacker key' });
  return credential;
}

describe('changePassword removes every passkey (PASSKEY-13)', () => {
  it('an attacker-added passkey is gone after the owner changes the password, and cannot sign in', async () => {
    const cred = await attackerRegisters();
    expect(h.creds).toHaveLength(1);

    await AuthService.changePassword('owner', OLD, NEW);

    expect(h.creds).toHaveLength(0);
    const o: any = await PasskeyService.beginAuthentication(ADMIN);
    await expect(
      PasskeyService.finishAuthentication(ADMIN, assert(cred, o, ADMIN) as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'PASSKEY_AUTH_FAILED' });
  });

  it('audits the removal and tells the owner, in their language, how many went and why', async () => {
    await attackerRegisters();
    h.mails = [];
    await AuthService.changePassword('owner', OLD, NEW);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'passkey.purged',
        userId: 'owner',
        details: { count: 1, reason: 'password_changed' },
      }),
    ]);
    expect(h.mails).toEqual([
      expect.objectContaining({
        kind: 'purged',
        email: 'o@x.com',
        count: 1,
        reason: 'password_changed',
      }),
    ]);
  });

  it('nothing to remove: no audit row and no email', async () => {
    await AuthService.changePassword('owner', OLD, NEW);
    expect(h.audits).toEqual([]);
    expect(h.mails).toEqual([]);
  });

  it('a wrong current password changes nothing: passkeys survive, no email', async () => {
    await attackerRegisters();
    h.mails = [];
    await expect(AuthService.changePassword('owner', 'wrong', NEW)).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    expect(h.creds).toHaveLength(1);
    expect(h.mails).toEqual([]);
  });
});

describe('the notice copy is true (review I1)', () => {
  const sample = (kind: 'added' | 'removed' | 'purged') => ({
    email: 'o@x.com',
    name: 'Mona',
    kind,
    passkeyName: 'k',
    count: 2,
    reason: 'password_changed' as const,
    at: '2026-10-21T10:00:00.000Z',
  });

  it('every sentence that promises "password change/reset removes passkeys" is backed by code', () => {
    const claims = [
      /Changing or resetting your password removes every passkey/,
      /تغيير كلمة المرور أو إعادة تعيينها يحذف كل مفاتيح المرور/,
    ];
    const rendered = [
      passkeyNoticeTemplate.en(sample('added')),
      passkeyNoticeTemplate.ar(sample('added')),
      passkeyNoticeTemplate.en(sample('removed')),
      passkeyNoticeTemplate.ar(sample('removed')),
    ];
    for (const html of rendered) expect(claims.some(c => c.test(html))).toBe(true);
    // ...and the code keeps the promise on BOTH paths.
    expect(AuthService.changePassword.toString()).toMatch(/passkeyCredential\.deleteMany/);
    expect(AuthService.resetPassword.toString()).toMatch(/passkeyCredential\.deleteMany/);
  });

  it('the purged notice states the count and the right verb in both languages', () => {
    expect(passkeyNoticeTemplate.en(sample('purged'))).toMatch(/changed[^<]*\(2\)/);
    expect(passkeyNoticeTemplate.ar(sample('purged'))).toMatch(/تغيير كلمة المرور[^<]*\(2\)/);
    expect(passkeyNoticeTemplate.en({ ...sample('purged'), reason: 'password_reset' })).toMatch(
      /reset/
    );
  });
});
