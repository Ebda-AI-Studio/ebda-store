/**
 * Ruling PASSKEY-11: removing a staff member from store A ends THEIR ACCESS TO STORE A and nothing else.
 * Sessions are per user, not per store; access to a store is the membership row, re-checked on every
 * request (`requireStoreAccess`). So the owner of A deleting the membership must never sign the person out
 * of store B (or of a store they own) and must never touch their passkeys, which are per-user.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  revokeAllSessions: vi.fn(),
  deleted: [] as any[],
  keyRevokes: [] as any[],
  passkeyTouches: [] as string[],
  inviteExpiries: [] as any[],
}));

vi.mock('@ebda/database', () => {
  const tx = {
    storeStaff: {
      findUnique: async ({ where }: any) => ({
        id: 'ss-1',
        ...where.userId_storeId,
        user: { email: 'Victim@Example.com' },
      }),
      delete: async (a: any) => void h.deleted.push(a.where.userId_storeId),
    },
    staffInvite: { updateMany: async (a: any) => void h.inviteExpiries.push(a) },
    merchantApiKey: { updateMany: async (a: any) => void h.keyRevokes.push(a.where) },
    passkeyCredential: new Proxy(
      {},
      { get: (_t, op: string) => async () => void h.passkeyTouches.push(op) }
    ),
    refreshToken: new Proxy(
      {},
      { get: (_t, op: string) => async () => void h.passkeyTouches.push(`refresh.${op}`) }
    ),
  };
  return {
    withStore: async (_s: string, fn: any) => fn(tx),
    withUser: async (_u: string, fn: any) => fn(tx),
    UserRole: {},
  };
});
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _r: any, n: any) => {
    req.user = { userId: 'owner-a', role: 'store_admin' };
    n();
  },
  authorize: () => (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/lib/definer', () => ({ ensureAdminUser: vi.fn(), findUserIdByEmail: vi.fn() }));
vi.mock('@api/services/plan-limit.service', () => ({ assertWithinLimit: vi.fn() }));
vi.mock('@api/services/platform-mailer', () => ({ sendStaffInviteEmail: vi.fn() }));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: any) => fn(),
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { revokeAllSessions: h.revokeAllSessions },
  RESET_TOKEN_TTL_MINUTES: 60,
  storeAppOrigin: () => 'https://x',
}));

let app: Express;
beforeAll(async () => {
  const { default: staffRoutes } = await import('@api/routes/staff.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/staff', staffRoutes);
  app.use(errorHandler);
});
beforeEach(() => {
  vi.clearAllMocks();
  h.deleted = [];
  h.keyRevokes = [];
  h.passkeyTouches = [];
  h.inviteExpiries = [];
});

describe('DELETE /stores/:storeId/staff/:userId (PASSKEY-11)', () => {
  it("removes ONLY store A's membership: no session revocation, no passkey or refresh-token writes", async () => {
    // The victim is also staff in store B (or a merchant of their own store): their B session must survive.
    const res = await request(app).delete('/api/v1/stores/store-a/staff/victim');
    expect(res.status).toBe(200);
    expect(h.deleted).toEqual([{ userId: 'victim', storeId: 'store-a' }]);
    expect(h.keyRevokes).toEqual([{ storeId: 'store-a', userId: 'victim', revokedAt: null }]);
    // pending invitations to the removed address die with the membership (Ruling ID-13)
    expect(h.inviteExpiries[0].where).toEqual({
      storeId: 'store-a',
      email: 'victim@example.com',
      status: 'pending',
    });
    expect(h.revokeAllSessions).not.toHaveBeenCalled();
    expect(h.passkeyTouches).toEqual([]);
  });
});
