/**
 * SELF-SERVICE gap A24 (team.audit-log): an owner reads their OWN store's activity log. Read-only, newest first, cursor
 * pagination, explicit select, PII masked, owner / store_admin only (staff 403); another store answers 404; a super admin keeps
 * the override through requireStoreAccess.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  brief: vi.fn(),
  audit: vi.fn(),
  owner: { id: 'u1' },
}));

vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'u1', role: req.header('x-role') ?? 'store_admin' };
      next();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
// requireStoreAccess is exercised for real in self-service-store-activity-auth.test.ts; here it only attaches the store row.
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (req: any, res: any, next: any) => {
    if (req.params.storeId !== 'store-a') return res.status(404).json({ success: false });
    req.store = { id: 'store-a', ownerId: m.owner.id };
    next();
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: m.audit }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ auditLog: { findMany: m.findMany } }),
}));
vi.mock('@api/lib/identity-client', () => ({ getAccountsBrief: m.brief }));

let app: Express;
beforeAll(async () => {
  const router = (await import('@api/routes/store-activity.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores/:storeId/activity', router);
  app.use(errorHandler as any);
});

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `id-${String(i).padStart(3, '0')}`,
  action: 'product.update',
  userId: 'actor-1',
  resourceType: 'product',
  resourceId: 'p1',
  createdAt: new Date(Date.UTC(2026, 10, 14, 12, 0, 60 - i)),
  ipAddress: '203.0.113.45',
  details: { name: 'Ring', ...extra },
});

beforeEach(() => {
  m.owner.id = 'u1';
  m.audit.mockReset().mockResolvedValue(undefined);
  m.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
  m.brief.mockReset().mockResolvedValue([
    {
      id: 'actor-1',
      firstName: 'Mona',
      lastName: 'Ali',
      role: 'staff',
      email: 'mona@example.com',
    },
  ]);
});

describe('A24 store activity log', () => {
  it('store_admin reads their own store: who / what / when, PII masked, no raw ip, no user agent', async () => {
    m.findMany.mockResolvedValue([
      row(1, { customerEmail: 'buyer@gmail.com', phone: '+201012345678', apiToken: 'sk_live_abc' }),
    ]);
    const res = await request(app).get('/stores/store-a/activity').set('x-role', 'store_admin');
    expect(res.status).toBe(200);
    const [a] = res.body.data.items;
    expect(a).toMatchObject({
      action: 'product.update',
      resourceType: 'product',
      actor: { name: 'Mona Ali', role: 'staff' },
    });
    expect(a.ip).toBe('203.0.113.*');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('buyer@gmail.com');
    expect(text).not.toContain('+201012345678');
    expect(text).not.toContain('sk_live_abc');
    expect(text).not.toContain('mona@example.com');
    expect(text).not.toContain('203.0.113.45');
    expect(text).not.toContain('userAgent');
  });

  it('queries only this store with an explicit select (never the whole row)', async () => {
    await request(app).get('/stores/store-a/activity');
    const arg = m.findMany.mock.calls[0][0];
    expect(arg.where.storeId).toBe('store-a');
    expect(arg.select).toBeTruthy();
    expect(arg.select.userAgent).toBeUndefined();
    expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('cursor pagination: asks for limit+1, returns nextCursor, and the cursor narrows the next query', async () => {
    m.findMany.mockResolvedValue([row(1), row(2), row(3)]);
    const first = await request(app).get('/stores/store-a/activity?limit=2');
    expect(m.findMany.mock.calls[0][0].take).toBe(3);
    expect(first.body.data.items).toHaveLength(2);
    const cursor = first.body.data.nextCursor as string;
    expect(typeof cursor).toBe('string');
    m.findMany.mockResolvedValue([row(3)]);
    const second = await request(app).get(
      `/stores/store-a/activity?limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(second.body.data.nextCursor).toBeNull();
    expect(JSON.stringify(m.findMany.mock.calls[1][0].where)).toContain('id-002');
  });

  it('refuses a garbage cursor and an oversized limit', async () => {
    expect((await request(app).get('/stores/store-a/activity?cursor=%%%')).status).toBe(400);
    expect((await request(app).get('/stores/store-a/activity?limit=500')).status).toBe(400);
  });

  it('staff are refused; another store answers 404; super_admin keeps the override', async () => {
    expect((await request(app).get('/stores/store-a/activity').set('x-role', 'staff')).status).toBe(
      403
    );
    expect(
      (await request(app).get('/stores/store-b/activity').set('x-role', 'store_admin')).status
    ).toBe(404);
    expect(
      (await request(app).get('/stores/store-a/activity').set('x-role', 'super_admin')).status
    ).toBe(200);
    expect(m.findMany).toHaveBeenCalledTimes(1);
  });

  it('free text under a neutral key loses its phone numbers and emails too; sensitive key families are dropped, look-alikes kept', async () => {
    m.findMany.mockResolvedValue([
      row(1, {
        note: 'call the buyer on +20 101 234 5678 or 01012345678, mail b@gmail.com',
        couponCode: 'EID10',
        postcode: '11511',
        apiKey: 'k_live_1',
        secretKey: 'sk_1',
        bearer: 'abc',
        nationalId: '29001010101010',
      }),
    ]);
    const res = await request(app).get('/stores/store-a/activity');
    const [a] = res.body.data.items;
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/234 5678|01012345678|b@gmail\.com|k_live_1|sk_1|abc|2900101/);
    expect(a.details).toMatchObject({ couponCode: 'EID10', postcode: '11511' });
  });

  it('the log still loads when the identity service is down: actor names degrade to null', async () => {
    m.brief.mockRejectedValue(new Error('identity down'));
    const res = await request(app).get('/stores/store-a/activity');
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].actor).toBeNull();
  });

  it('a store_admin who is not the owner of the attached store row is refused here too (defence in depth)', async () => {
    m.owner.id = 'someone-else';
    expect(
      (await request(app).get('/stores/store-a/activity').set('x-role', 'store_admin')).status
    ).toBe(403);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('a super_admin read of a store log leaves an audit row; an owner read leaves none', async () => {
    await request(app).get('/stores/store-a/activity').set('x-role', 'store_admin');
    expect(m.audit).not.toHaveBeenCalled();
    await request(app).get('/stores/store-a/activity').set('x-role', 'super_admin');
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][0]).toMatchObject({
      action: 'STORE_ACTIVITY_VIEWED',
      userId: 'u1',
      storeId: 'store-a',
    });
  });
});
