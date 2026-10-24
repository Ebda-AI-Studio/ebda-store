/**
 * Staff invitations (Ruling ID-13): an invite never binds a store to someone else's account. New address = fresh identity;
 * any existing account (unverified, mid-signup, no Store profile yet, or a merchant) = an e-mailed ACCEPT step the invitee
 * performs signed in as that address. Covers the cross-tenant takeover attempt and both accept cases.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const h = vi.hoisted(() => ({
  userCreates: [] as any[],
  staffCreates: [] as any[],
  members: new Set<string>(),
  mails: [] as any[],
  invite: vi.fn(),
  account: vi.fn(),
  setRole: vi.fn(async () => {}),
  existingId: null as string | null,
  owned: [] as string[],
  actor: { userId: 'owner-a', role: 'store_admin' } as any,
  ensure: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const tx = {
    user: { create: async (a: any) => void h.userCreates.push(a.data) },
    store: { findUnique: async () => ({ id: 'store-a', deletedAt: null }) },
    storeStaff: {
      findUnique: async ({ where }: any) =>
        h.members.has(where.userId_storeId.userId) ? { id: 'ss' } : null,
      create: async (a: any) => {
        h.staffCreates.push(a.data);
        return { id: 'ss-new' };
      },
    },
  };
  return {
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
  setAccountRole: (...a: unknown[]) => h.setRole(...(a as [])),
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

const INVITE = { email: 'Victim@Example.com'.toLowerCase(), firstName: 'V', lastName: 'Ictim' };
const add = () => request(app).post('/api/v1/stores/store-a/staff').send(INVITE);

beforeEach(() => {
  vi.clearAllMocks();
  h.userCreates = [];
  h.staffCreates = [];
  h.members = new Set();
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

  it('TAKEOVER ATTEMPT: the address has an unverified merchant identity of another tenant -> no profile row, no membership, an accept mail only', async () => {
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
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].acceptUrl).toMatch(/^https:\/\/admin\.example\/accept-invite#token=/);
    expect(h.mails[0].setPasswordUrl).toBeNull();
  });

  it('defence in depth: an identity that claims created but answers with a different id is refused', async () => {
    h.invite.mockResolvedValue({ id: 'someone-elses-id', created: true });
    const res = await add();
    expect(res.status).toBe(409);
    expect(h.userCreates).toEqual([]);
    expect(h.staffCreates).toEqual([]);
  });

  it.each(['customer', 'super_admin'])('refuses when the identity REAL role is %s', async role => {
    h.invite.mockResolvedValue({ id: 'x', created: false, emailVerified: true, role });
    expect((await add()).status).toBe(409);
    expect(h.mails).toEqual([]);
  });

  it('refuses a platform admin that already has a Store profile (real role from the identity, not a literal)', async () => {
    h.existingId = 'admin-1';
    h.account.mockResolvedValue({ role: 'super_admin', emailVerified: true });
    expect((await add()).status).toBe(409);
    expect(h.staffCreates).toEqual([]);
  });

  it('a mid-signup merchant (Store profile exists, e-mail unverified) -> accept mail, no membership', async () => {
    h.existingId = 'pending-1';
    h.account.mockResolvedValue({ role: 'store_admin', emailVerified: false });
    const res = await add();
    expect(res.status).toBe(202);
    expect(h.staffCreates).toEqual([]);
    expect(h.mails[0].acceptUrl).toBeTruthy();
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
      email: INVITE.email,
      firstName: 'V',
      lastName: 'I',
    });
    const res = await add();
    expect(res.status).toBe(201);
    expect(h.staffCreates).toEqual([{ storeId: 'store-a', userId: 'staff-1' }]);
  });
});

async function inviteToken(over: Record<string, unknown> = {}, aud = 'ebda:staff-invite') {
  const { config } = await import('@api/config');
  return jwt.sign({ email: INVITE.email, storeId: 'store-a', ...over }, config.jwtSecret, {
    algorithm: 'HS256',
    audience: aud,
    issuer: 'ebda-api',
    expiresIn: '1h',
  });
}
const accept = async (over?: Record<string, unknown>) =>
  request(app)
    .post('/api/v1/staff-invites/accept')
    .send({ token: await inviteToken(over) });

describe('POST /staff-invites/accept: the explicit accept step', () => {
  beforeEach(() => {
    h.actor = { userId: 'me', role: 'store_admin' };
  });

  it('a pending/verified merchant WITHOUT a store accepts: membership created, sign-in role switched to staff, re-login requested', async () => {
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'store_admin',
      emailVerified: true,
      status: 'active',
    });
    const res = await accept();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ storeId: 'store-a', requiresSignIn: true });
    expect(h.staffCreates).toEqual([{ storeId: 'store-a', userId: 'me' }]);
    expect(h.setRole).toHaveBeenCalledWith('me', 'staff', 'staff-invite-accepted');
  });

  it('an account with no Store membership yet (already staff in the identity) accepts without a role switch', async () => {
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'staff',
      emailVerified: true,
      status: 'active',
    });
    const res = await accept();
    expect(res.status).toBe(200);
    expect(res.body.data.requiresSignIn).toBe(false);
    expect(h.staffCreates).toHaveLength(1);
    expect(h.setRole).not.toHaveBeenCalled();
  });

  it('accepting twice is harmless', async () => {
    h.members.add('me');
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'staff',
      emailVerified: true,
      status: 'active',
    });
    expect((await accept()).status).toBe(200);
    expect(h.staffCreates).toEqual([]);
  });

  it('an account that OWNS a store is refused and left untouched', async () => {
    h.owned = ['store-z'];
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'store_admin',
      emailVerified: true,
      status: 'active',
    });
    const res = await accept();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWNS_STORE');
    expect(h.staffCreates).toEqual([]);
    expect(h.setRole).not.toHaveBeenCalled();
  });

  it('refuses an unverified e-mail, a different signed-in address, a customer or platform admin', async () => {
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'staff',
      emailVerified: false,
      status: 'active',
    });
    expect((await accept()).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    h.account.mockResolvedValue({
      id: 'me',
      email: 'other@example.com',
      role: 'staff',
      emailVerified: true,
      status: 'active',
    });
    expect((await accept()).body.error.code).toBe('INVITE_EMAIL_MISMATCH');
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'super_admin',
      emailVerified: true,
      status: 'active',
    });
    expect((await accept()).status).toBe(409);
    expect(h.staffCreates).toEqual([]);
  });

  it('refuses a token with the wrong audience (a session token is not an invitation) and garbage', async () => {
    h.account.mockResolvedValue({
      id: 'me',
      email: INVITE.email,
      role: 'staff',
      emailVerified: true,
      status: 'active',
    });
    const wrongAud = await inviteToken({}, 'ebda-store');
    expect(
      (await request(app).post('/api/v1/staff-invites/accept').send({ token: wrongAud })).body.error
        .code
    ).toBe('INVITE_INVALID');
    expect(
      (
        await request(app)
          .post('/api/v1/staff-invites/accept')
          .send({ token: 'x'.repeat(40) })
      ).body.error.code
    ).toBe('INVITE_INVALID');
    expect(h.staffCreates).toEqual([]);
  });
});
