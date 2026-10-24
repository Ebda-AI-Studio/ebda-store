/**
 * Staff invitations (Ruling ID-13): an invite never binds a store to someone else's account. New address = fresh identity;
 * any existing account (unverified, mid-signup, no Store profile yet, or a merchant) = an e-mailed ACCEPT step the invitee
 * performs signed in as that address, backed by a STATEFUL pending-invite row: single use, revocable, ended by removal.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const EMAIL = 'victim@example.com';

const h = vi.hoisted(() => ({
  userCreates: [] as any[],
  staffCreates: [] as any[],
  members: new Set<string>(),
  invites: [] as any[],
  mails: [] as any[],
  invite: vi.fn(),
  account: vi.fn(),
  setRole: vi.fn(async (..._a: unknown[]) => {}),
  existingId: null as string | null,
  owned: [] as string[],
  actor: { userId: 'owner-a', role: 'store_admin' } as any,
  ensure: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const tx = {
    user: { create: async (a: any) => void h.userCreates.push(a.data) },
    store: { findUnique: async () => ({ id: 'store-a', deletedAt: null }) },
    staffInvite: {
      create: async (a: any) => void h.invites.push({ status: 'pending', ...a.data }),
      findMany: async () => h.invites.filter(i => i.status === 'pending'),
      findFirst: async ({ where }: any) =>
        h.invites.find(
          i => i.id === where.id && i.status === where.status && i.acceptedBy === where.acceptedBy
        ) ?? null,
      updateMany: async ({ where, data }: any) => {
        const hit = h.invites.filter(
          i =>
            (where.id === undefined || i.id === where.id) &&
            (where.email === undefined || i.email === where.email) &&
            i.status === where.status &&
            (!where.expiresAt || i.expiresAt > where.expiresAt.gt)
        );
        hit.forEach(i => Object.assign(i, data));
        return { count: hit.length };
      },
    },
    storeStaff: {
      findUnique: async ({ where }: any) =>
        h.members.has(where.userId_storeId.userId) ? { id: 'ss', user: { email: EMAIL } } : null,
      create: async (a: any) => {
        h.staffCreates.push(a.data);
        h.members.add(a.data.userId);
        return { id: 'ss-new' };
      },
      delete: async ({ where }: any) => void h.members.delete(where.userId_storeId.userId),
    },
    merchantApiKey: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    Prisma: {},
    withStore: async (_s: string, fn: any) => fn(tx),
    withUser: async (_u: string, fn: any) => fn(tx),
    UserRole: {
      staff: 'staff',
      customer: 'customer',
      super_admin: 'super_admin',
      store_admin: 'store_admin',
    },
  };
});
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _r: any, n: any) => {
    req.user = h.actor;
    n();
  },
  authorize: () => (_q: any, _r: any, n: any) => n(),
  rejectImpersonated: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (req: any, _r: any, n: any) => {
    req.store = { id: 'store-a', name: 'Store A' };
    n();
  },
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/lib/definer', () => ({
  ensureAdminUser: (...a: unknown[]) => h.ensure(...a),
  findUserIdByEmail: async () => h.existingId,
  ownedStoreIds: async () => h.owned,
}));
vi.mock('@api/lib/identity-client', () => ({
  inviteIdentity: (...a: unknown[]) => h.invite(...a),
  getAccountState: (...a: unknown[]) => h.account(...a),
  setAccountRole: (...a: unknown[]) => h.setRole(...a),
}));
vi.mock('@api/services/plan-limit.service', () => ({ assertWithinLimit: vi.fn() }));
vi.mock('@api/services/platform-mailer', () => ({
  sendStaffInviteEmail: async (d: any) => void h.mails.push(d),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: any) => fn(),
}));
vi.mock('@api/services/auth.service', () => ({
  RESET_TOKEN_TTL_MINUTES: 60,
  storeAppOrigin: () => 'https://admin.example',
}));

let app: Express;
beforeAll(async () => {
  const { default: staffRoutes } = await import('@api/routes/staff.routes');
  const { default: inviteRoutes } = await import('@api/routes/staff-invite.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/staff', staffRoutes);
  app.use('/api/v1/staff-invites', inviteRoutes);
  app.use(errorHandler);
});

const INVITE = { email: EMAIL, firstName: 'V', lastName: 'Ictim' };
const add = () => request(app).post('/api/v1/stores/store-a/staff').send(INVITE);
const tokenOf = (mail: any) => decodeURIComponent(String(mail.acceptUrl).split('#token=')[1]);

beforeEach(() => {
  vi.clearAllMocks();
  h.userCreates = [];
  h.staffCreates = [];
  h.members = new Set();
  h.invites = [];
  h.mails = [];
  h.existingId = null;
  h.owned = [];
  h.actor = { userId: 'owner-a', role: 'store_admin' };
});

describe('POST /stores/:id/staff: an invite never binds to an existing identity', () => {
  it('a brand-new address: fresh identity under the id THIS request generated, profile row with that id', async () => {
    h.invite.mockImplementation(async (i: any) => ({ id: i.id, created: true }));
    const res = await add();
    expect(res.status).toBe(201);
    const sent = h.invite.mock.calls[0][0];
    expect(h.userCreates[0].id).toBe(sent.id);
    expect(h.staffCreates).toEqual([{ storeId: 'store-a', userId: sent.id }]);
  });

  it('TAKEOVER ATTEMPT: unverified merchant identity of another tenant -> no profile row, no membership, a pending invite + accept mail only', async () => {
    h.invite.mockResolvedValue({
      id: 'victim-id',
      created: false,
      emailVerified: false,
      role: 'store_admin',
    });
    const res = await add();
    expect(res.status).toBe(202);
    expect(h.userCreates).toEqual([]);
    expect(h.staffCreates).toEqual([]);
    expect(h.invites).toHaveLength(1);
    expect(h.invites[0]).toMatchObject({ status: 'pending', email: EMAIL, storeId: 'store-a' });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].acceptUrl).toMatch(/^https:\/\/admin\.example\/accept-invite#token=/);
    expect(h.mails[0].setPasswordUrl).toBeNull();
  });

  it('defence in depth: an identity that claims created but answers with a different id is refused', async () => {
    h.invite.mockResolvedValue({ id: 'someone-elses-id', created: true });
    expect((await add()).status).toBe(409);
    expect(h.userCreates).toEqual([]);
    expect(h.staffCreates).toEqual([]);
  });

  it.each(['customer', 'super_admin'])('refuses when the identity REAL role is %s', async role => {
    h.invite.mockResolvedValue({ id: 'x', created: false, emailVerified: true, role });
    expect((await add()).status).toBe(409);
    expect(h.mails).toEqual([]);
    expect(h.invites).toEqual([]);
  });

  it('refuses a platform admin that already has a Store profile (real role from the identity, not a literal)', async () => {
    h.existingId = 'admin-1';
    h.account.mockResolvedValue({ role: 'super_admin', emailVerified: true });
    expect((await add()).status).toBe(409);
    expect(h.staffCreates).toEqual([]);
  });

  it('a mid-signup merchant (Store profile exists, e-mail unverified) -> pending invite, no membership', async () => {
    h.existingId = 'pending-1';
    h.account.mockResolvedValue({ role: 'store_admin', emailVerified: false });
    expect((await add()).status).toBe(202);
    expect(h.staffCreates).toEqual([]);
    expect(h.invites).toHaveLength(1);
  });

  it('a verified merchant (store_admin) is also asked to accept, never added silently', async () => {
    h.existingId = 'merchant-1';
    h.account.mockResolvedValue({ role: 'store_admin', emailVerified: true });
    expect((await add()).status).toBe(202);
    expect(h.staffCreates).toEqual([]);
  });

  it('an already-verified staff account is added at once (it already is staff)', async () => {
    h.existingId = 'staff-1';
    h.account.mockResolvedValue({ role: 'staff', emailVerified: true });
    h.ensure.mockResolvedValue({
      id: 'staff-1',
      created: false,
      role: 'staff',
      status: 'active',
      email: EMAIL,
      firstName: 'V',
      lastName: 'I',
    });
    expect((await add()).status).toBe(201);
    expect(h.staffCreates).toEqual([{ storeId: 'store-a', userId: 'staff-1' }]);
  });

  it('re-inviting supersedes the earlier pending invite (only the newest link works)', async () => {
    h.invite.mockResolvedValue({
      id: 'v',
      created: false,
      emailVerified: true,
      role: 'store_admin',
    });
    await add();
    await add();
    expect(h.invites.map(i => i.status)).toEqual(['revoked', 'pending']);
  });
});

describe('pending invitations: list and revoke', () => {
  it('lists pending invites and revoking one is idempotently refused the second time', async () => {
    h.invite.mockResolvedValue({
      id: 'v',
      created: false,
      emailVerified: true,
      role: 'store_admin',
    });
    await add();
    const list = await request(app).get('/api/v1/stores/store-a/staff/invites');
    expect(list.body.data.invites).toHaveLength(1);
    const id = h.invites[0].id;
    expect((await request(app).delete(`/api/v1/stores/store-a/staff/invites/${id}`)).status).toBe(
      200
    );
    expect((await request(app).delete(`/api/v1/stores/store-a/staff/invites/${id}`)).status).toBe(
      404
    );
  });
});

const goodAccount = (over: Record<string, unknown> = {}) => ({
  id: 'me',
  email: EMAIL,
  role: 'staff',
  emailVerified: true,
  status: 'active',
  ...over,
});
/** Issue a real invitation through the owner endpoint and return its signed token. */
async function issue(): Promise<string> {
  h.invite.mockResolvedValue({ id: 'v', created: false, emailVerified: true, role: 'store_admin' });
  const before = h.mails.length;
  await add();
  return tokenOf(h.mails[before]);
}
const accept = (token: string) => request(app).post('/api/v1/staff-invites/accept').send({ token });

describe('POST /staff-invites/accept: the explicit accept step', () => {
  beforeEach(() => {
    h.actor = { userId: 'me', role: 'store_admin' };
  });

  it('a pending/verified merchant WITHOUT a store accepts: membership created, role switched to staff, re-login requested', async () => {
    const token = await issue();
    h.account.mockResolvedValue(goodAccount({ role: 'store_admin' }));
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ storeId: 'store-a', requiresSignIn: true });
    expect(h.staffCreates).toEqual([{ storeId: 'store-a', userId: 'me' }]);
    expect(h.setRole).toHaveBeenCalledWith('me', 'staff', 'staff-invite-accepted');
  });

  it('an account with no Store membership yet (already staff in the identity) accepts without a role switch', async () => {
    const token = await issue();
    h.account.mockResolvedValue(goodAccount());
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(res.body.data.requiresSignIn).toBe(false);
    expect(h.setRole).not.toHaveBeenCalled();
  });

  it('RE-ACCEPTING A USED INVITE fails and creates nothing', async () => {
    const token = await issue();
    h.account.mockResolvedValue(goodAccount());
    expect((await accept(token)).status).toBe(200);
    h.members.clear();
    const again = await accept(token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVITE_INVALID');
    expect(h.staffCreates).toHaveLength(1);
  });

  it('AN INVITE ACCEPTED AFTER REMOVAL fails: removing the member expires its pending invites', async () => {
    // owner invites, the address is later added/removed as a member, the old link is dead
    const token = await issue();
    h.members.add('me');
    expect((await request(app).delete('/api/v1/stores/store-a/staff/me')).status).toBe(200);
    expect(h.invites.every(i => i.status !== 'pending')).toBe(true);
    h.account.mockResolvedValue(goodAccount());
    const res = await accept(token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVITE_INVALID');
    expect(h.staffCreates).toEqual([]);
  });

  it('A REVOKED INVITE fails', async () => {
    const token = await issue();
    await request(app).delete(`/api/v1/stores/store-a/staff/invites/${h.invites[0].id}`);
    h.account.mockResolvedValue(goodAccount());
    const res = await accept(token);
    expect(res.status).toBe(400);
    expect(h.staffCreates).toEqual([]);
  });

  it('a SUPERSEDED invite (the owner re-invited) fails; the newest works', async () => {
    const first = await issue();
    const second = await issue();
    h.account.mockResolvedValue(goodAccount());
    expect((await accept(first)).status).toBe(400);
    expect((await accept(second)).status).toBe(200);
  });

  it('an EXPIRED invite fails', async () => {
    const token = await issue();
    h.invites[0].expiresAt = new Date(Date.now() - 1000);
    h.account.mockResolvedValue(goodAccount());
    expect((await accept(token)).status).toBe(400);
    expect(h.staffCreates).toEqual([]);
  });

  it('the account that accepted may repeat while its membership stands (finishing a half-done role switch)', async () => {
    const token = await issue();
    h.account.mockResolvedValue(goodAccount({ role: 'store_admin' }));
    h.setRole.mockRejectedValueOnce(new Error('identity down'));
    expect((await accept(token)).status).toBeGreaterThanOrEqual(500);
    expect(h.members.has('me')).toBe(true);
    expect((await accept(token)).status).toBe(200);
    expect(h.setRole).toHaveBeenCalledTimes(2);
    expect(h.staffCreates).toHaveLength(1);
  });

  it('an account that OWNS a store is refused and the invite stays pending', async () => {
    const token = await issue();
    h.owned = ['store-z'];
    h.account.mockResolvedValue(goodAccount({ role: 'store_admin' }));
    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWNS_STORE');
    expect(h.staffCreates).toEqual([]);
    expect(h.invites[0].status).toBe('pending');
    expect(h.setRole).not.toHaveBeenCalled();
  });

  it('refuses an unverified e-mail, a different signed-in address, a customer or platform admin', async () => {
    const token = await issue();
    h.account.mockResolvedValue(goodAccount({ emailVerified: false }));
    expect((await accept(token)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    h.account.mockResolvedValue(goodAccount({ email: 'other@example.com' }));
    expect((await accept(token)).body.error.code).toBe('INVITE_EMAIL_MISMATCH');
    h.account.mockResolvedValue(goodAccount({ role: 'super_admin' }));
    expect((await accept(token)).status).toBe(409);
    expect(h.staffCreates).toEqual([]);
    expect(h.invites[0].status).toBe('pending');
  });

  it('refuses a token with the wrong audience, a forged token for a row that does not exist, and garbage', async () => {
    h.account.mockResolvedValue(goodAccount());
    const { config } = await import('@api/config');
    const sign = (aud: string, jti: string) =>
      jwt.sign({ email: EMAIL, storeId: 'store-a' }, config.jwtSecret, {
        algorithm: 'HS256',
        audience: aud,
        issuer: 'ebda-api',
        expiresIn: '1h',
        jwtid: jti,
      });
    for (const t of [
      sign('ebda-store', 'x'),
      sign('ebda:staff-invite', 'no-such-row'),
      'x'.repeat(40),
    ]) {
      expect((await accept(t)).body.error.code).toBe('INVITE_INVALID');
    }
    expect(h.staffCreates).toEqual([]);
  });
});
