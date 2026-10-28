/**
 * Ruling PASSKEY-8, review M6: parity as BEHAVIOUR. For every gate condition, the same account is signed
 * into through the password path (`AuthService.login`) and the passkey path
 * (`PasskeyService.finishAuthentication`) in the same fake world, and the outcomes must agree: refused or
 * admitted, and what each attempt does to the shared lockout counter. (`login-gate-parity.test.ts` is the
 * cheap tripwire that fails when a gate is added to one path; THIS file proves what the gates do.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { register, assert, type SoftCredential } from '../helpers/software-authenticator';

const ADMIN = 'https://admin.ebda.app';
const STORE_A = 'https://shop-a.ebda.app';
type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  creds: [] as Row[],
  users: new Map<string, Row>(),
  fails: new Map<string, number>(),
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
vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: async (k: string) => ({ locked: (h.fails.get(k) ?? 0) >= 5, remainingMs: 60000 }),
    recordFailedAttempt: async (k: string) => {
      const n = (h.fails.get(k) ?? 0) + 1;
      h.fails.set(k, n);
      return { locked: n >= 5, attemptsRemaining: Math.max(0, 5 - n), lockoutDurationMs: 60000 };
    },
    recordSuccessfulLogin: async (k: string) => void h.fails.delete(k),
    unlockAccount: async () => undefined,
  },
}));
vi.mock('@api/lib/definer', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/lib/definer')>();
  return {
    ...actual,
    lookupStore: async (m: { slug?: string }) =>
      m.slug === 'shop-a' ? { id: 'store-a', status: 'active' } : null,
    passkeyLookup: async (id: string) => h.creds.find(c => c.credentialId === id) ?? null,
    findUserIdByEmail: async (email: string, storeId: string | null) =>
      [...h.users.values()].find(
        u => u.email === email.toLowerCase() && (u.storeId ?? null) === storeId && !u.deletedAt
      )?.id ?? null,
  };
});
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  const tx = {
    user: { findUnique: async ({ where }: any) => h.users.get(where.id) ?? null },
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
vi.mock('@api/services/platform-mailer', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/services/platform-mailer')>();
  return { ...actual, sendPasskeyNoticeEmail: async () => undefined };
});
vi.mock('@api/services/encryption.service', () => ({ encryption: { decrypt: (s: string) => s } }));

import { AuthService } from '@api/services/auth.service';
import { PasskeyService } from '@api/services/passkey.service';

const SECRET = 'Correct-pw-1!';
const HASH = bcrypt.hashSync(SECRET, 4);
const mk = (over: Row = {}): Row => ({
  id: 'u1',
  email: 'm@x.com',
  firstName: 'M',
  lastName: 'S',
  language: 'en',
  role: 'store_admin',
  storeId: null,
  status: 'active',
  deletedAt: null,
  emailVerified: true,
  tokenVersion: 0,
  mfaEnabled: false,
  mfaSecret: null,
  passwordHash: HASH,
  ...over,
});

interface World {
  /** key the shared counter lives under for this account */
  key: string;
  origin: string;
  storeId: string | null;
  cred: SoftCredential;
}
let world: World;

async function enrolFor(userId: string, origin: string): Promise<SoftCredential> {
  const actor = { userId, sessionId: 's' };
  await PasskeyService.markStepUp(userId, 's');
  const options: any = await PasskeyService.beginRegistration(actor, origin);
  const { credential, response } = register(options, origin);
  await PasskeyService.finishRegistration(actor, origin, { response, name: 'k' });
  return credential;
}

/** Sign in with the password path. Resolves to 'admitted' or 'refused'. */
async function viaPassword(secret: string): Promise<'admitted' | 'refused'> {
  const u = [...h.users.values()][0];
  try {
    const r = await AuthService.login(u.email, secret, '1.2.3.4', world.storeId);
    return r ? 'admitted' : 'refused';
  } catch {
    return 'refused';
  }
}

/** Sign in with the passkey path; `valid=false` tampers with the signature. */
async function viaPasskey(valid: boolean): Promise<'admitted' | 'refused'> {
  const o: any = await PasskeyService.beginAuthentication(world.origin);
  const response: any = assert(world.cred, o, world.origin);
  if (!valid) response.response.signature = Buffer.alloc(70, 9).toString('base64url');
  try {
    await PasskeyService.finishAuthentication(world.origin, response, undefined, { ip: '1.2.3.4' });
    return 'admitted';
  } catch {
    return 'refused';
  }
}

const setup = async (userOver: Row, origin: string) => {
  h.users = new Map([['u1', mk(userOver)]]);
  const u = h.users.get('u1')!;
  world = {
    key: u.storeId ? `${u.storeId}:${u.email}` : u.email,
    origin,
    storeId: u.storeId,
    cred: await enrolFor('u1', origin),
  };
};

beforeEach(() => {
  h.redis.clear();
  h.creds = [];
  h.fails = new Map();
  vi.spyOn(AuthService, 'issueSessionFor').mockResolvedValue({ user: {} } as never);
});

// The two surfaces: the admin namespace, and a shopper of store A.
const SURFACES: Array<[string, Row, string]> = [
  ['merchant (admin app)', {}, ADMIN],
  ['shopper (store A)', { role: 'customer', storeId: 'store-a' }, STORE_A],
];

describe.each(SURFACES)('login gates behave the same on both paths: %s', (_n, userOver, origin) => {
  beforeEach(async () => setup(userOver, origin));

  it('a good credential is admitted by both, and clears a partial failure count on both', async () => {
    h.fails.set(world.key, 3);
    // Merchants, staff and super admins sign in at the identity service (Rulings ID-1/ID-2): the legacy password path
    // verifies the credential (and clears the counter) but issues nothing for them. A store shopper is admitted.
    expect(await viaPassword(SECRET)).toBe(userOver.role === 'customer' ? 'admitted' : 'refused');
    expect(h.fails.get(world.key)).toBeUndefined();
    h.fails.set(world.key, 3);
    expect(await viaPasskey(true)).toBe('admitted');
    expect(h.fails.get(world.key)).toBeUndefined();
  });

  it('a bad credential is refused by both and adds exactly one to the SAME counter', async () => {
    expect(await viaPassword('wrong')).toBe('refused');
    expect(h.fails.get(world.key)).toBe(1);
    expect(await viaPasskey(false)).toBe('refused');
    expect(h.fails.get(world.key)).toBe(2);
  });

  it('a locked account refuses a CORRECT credential on both paths and stays locked', async () => {
    h.fails.set(world.key, 5);
    expect(await viaPassword(SECRET)).toBe('refused');
    expect(await viaPasskey(true)).toBe('refused');
    expect(h.fails.get(world.key)).toBe(5);
  });

  it('alternating methods does not dodge lockout: 3 bad passwords + 2 bad passkeys lock both', async () => {
    for (let i = 0; i < 3; i++) await viaPassword('wrong');
    for (let i = 0; i < 2; i++) await viaPasskey(false);
    expect(h.fails.get(world.key)).toBe(5);
    expect(await viaPassword(SECRET)).toBe('refused');
    expect(await viaPasskey(true)).toBe('refused');
  });

  it.each([
    ['suspended', { status: 'suspended' }],
    ['inactive', { status: 'inactive' }],
    ['soft-deleted', { deletedAt: new Date() }],
  ])('a %s account is refused by both, even with a correct credential', async (_l, patch) => {
    h.users.set('u1', { ...h.users.get('u1')!, ...patch });
    expect(await viaPassword(SECRET)).toBe('refused');
    expect(await viaPasskey(true)).toBe('refused');
  });
});

describe('lockout scoping is the same on both paths', () => {
  it("a shopper's failures on store A never touch the same email's admin-namespace counter", async () => {
    await setup({ role: 'customer', storeId: 'store-a' }, STORE_A);
    await viaPassword('wrong');
    await viaPasskey(false);
    expect(h.fails.get('store-a:m@x.com')).toBe(2);
    expect(h.fails.get('m@x.com')).toBeUndefined();
  });
});
