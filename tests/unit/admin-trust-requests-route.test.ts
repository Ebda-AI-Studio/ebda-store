/**
 * Super-admin review of trust / support requests: list with filters, detail, audited RESOLVE and REJECT for every kind,
 * MFA + super_admin on every route, a request is decided once, and the grant helpers close the matching open request.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({ rows: [] as Row[], audit: vi.fn() }));
const U1 = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const match = (r: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(r[k]);
      if ('gte' in v || 'lte' in v)
        return (!('gte' in v) || r[k] >= v.gte) && (!('lte' in v) || r[k] <= v.lte);
    }
    return r[k] === v;
  });
const trustRequest = {
  findMany: async ({ where, take, cursor, skip }: any) => {
    const hit = h.rows
      .filter(r => match(r, where))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const start = cursor ? hit.findIndex(r => r.id === cursor.id) + (skip ?? 0) : 0;
    return hit.slice(start, start + take);
  },
  findFirst: async ({ where }: any) => h.rows.find(r => match(r, where)) ?? null,
  updateMany: async ({ where, data }: any) => {
    const hit = h.rows.filter(r => match(r, where));
    hit.forEach(r => Object.assign(r, data));
    return { count: hit.length };
  },
};
vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return { ...real, prisma: { trustRequest } };
});
vi.mock('@api/lib/platform-scope', () => ({
  asOperator: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', role: req.header('x-role') ?? 'super_admin' };
      next();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (req: any, res: any, next: any) =>
    req.header('x-no-mfa') ? res.status(403).json({ success: false }) : next(),
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return { ...real, auditLog: h.audit };
});

vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: async ({ where }: any) => (where.id === S1 ? { ownerId: U1 } : null) },
  }),
}));

const seed = () => {
  const t = Date.now();
  h.rows.push(
    {
      id: id(1),
      kind: 'support',
      status: 'open',
      storeId: S1,
      userId: U1,
      topic: 'billing',
      message: 'a',
      createdAt: new Date(t - 5000),
    },
    {
      id: id(2),
      kind: 'suspension_appeal',
      status: 'open',
      storeId: S1,
      userId: U1,
      message: 'b',
      createdAt: new Date(t - 4000),
    },
    {
      id: id(3),
      kind: 'slug_claim',
      status: 'open',
      storeId: null,
      userId: U1,
      slug: 'nike',
      message: 'c',
      createdAt: new Date(t - 3000),
    },
    {
      id: id(4),
      kind: 'store_cap',
      status: 'open',
      storeId: null,
      userId: U1,
      message: 'd',
      createdAt: new Date(t - 2000),
    },
    {
      id: id(5),
      kind: 'support',
      status: 'resolved',
      storeId: S2,
      userId: 'u2',
      topic: 'plan',
      message: 'e',
      createdAt: new Date(t - 1000),
    },
    {
      id: id(6),
      kind: 'suspension',
      status: 'open',
      storeId: S1,
      userId: 'admin-1',
      message: 'reason',
      createdAt: new Date(t),
    }
  );
};

let app: Express;
beforeAll(async () => {
  const router = (await import('@api/routes/admin-trust-requests.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/admin', router);
  app.use(errorHandler as any);
});
beforeEach(() => {
  h.rows.length = 0;
  h.audit.mockReset().mockResolvedValue(undefined);
  seed();
});

describe('GET /admin/trust-requests', () => {
  it('lists the four request kinds newest first and never the suspension notes', async () => {
    const res = await request(app).get('/admin/trust-requests');
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r: Row) => r.id)).toEqual([id(5), id(4), id(3), id(2), id(1)]);
  });
  it('filters by kind, status, store and created range', async () => {
    const q = async (s: string) =>
      (await request(app).get(`/admin/trust-requests?${s}`)).body.data.rows.map((r: Row) => r.id);
    expect(await q('kind=slug_claim')).toEqual([id(3)]);
    expect(await q('status=resolved')).toEqual([id(5)]);
    expect(await q(`storeId=${S1}`)).toEqual([id(2), id(1)]);
    expect(await q(`from=${new Date(Date.now() - 3500).toISOString()}`)).toEqual([
      id(5),
      id(4),
      id(3),
    ]);
    expect(await q(`to=${new Date(Date.now() - 3500).toISOString()}`)).toEqual([id(2), id(1)]);
  });
  it('pages with a cursor', async () => {
    const first = (await request(app).get('/admin/trust-requests?limit=2')).body.data;
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBe(id(4));
    const second = (
      await request(app).get(`/admin/trust-requests?limit=2&cursor=${first.nextCursor}`)
    ).body.data;
    expect(second.rows.map((r: Row) => r.id)).toEqual([id(3), id(2)]);
  });
  it('rejects an unknown kind (400)', async () => {
    expect((await request(app).get('/admin/trust-requests?kind=suspension')).status).toBe(400);
  });
});

describe('GET /admin/trust-requests/:id', () => {
  it('returns one request; unknown and note ids are 404', async () => {
    expect((await request(app).get(`/admin/trust-requests/${id(3)}`)).body.data.request.slug).toBe(
      'nike'
    );
    expect((await request(app).get(`/admin/trust-requests/${id(99)}`)).status).toBe(404);
    expect((await request(app).get(`/admin/trust-requests/${id(6)}`)).status).toBe(404);
  });
});

describe('RESOLVE and REJECT for every kind', () => {
  it.each([
    [1, 'support'],
    [2, 'suspension_appeal'],
    [3, 'slug_claim'],
    [4, 'store_cap'],
  ])('request %i (%s): resolve then it cannot be decided again', async (n, kind) => {
    const res = await request(app).post(`/admin/trust-requests/${id(n)}/resolve`);
    expect(res.status).toBe(200);
    expect(h.rows.find(r => r.id === id(n))!.status).toBe('resolved');
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trust_request.resolve',
        resourceType: 'trust_request',
        resourceId: id(n),
        userId: 'admin-1',
        details: { kind, status: 'resolved' },
      })
    );
    expect((await request(app).post(`/admin/trust-requests/${id(n)}/reject`)).status).toBe(409);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2, 3, 4])('request %i: reject stamps rejected_at and audits', async n => {
    const res = await request(app).post(`/admin/trust-requests/${id(n)}/reject`);
    expect(res.status).toBe(200);
    const row = h.rows.find(r => r.id === id(n))!;
    expect(row.status).toBe('rejected');
    expect(row.rejectedAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trust_request.reject' })
    );
  });
  it('a suspension note is not decidable (404) and an already decided request is 409', async () => {
    expect((await request(app).post(`/admin/trust-requests/${id(6)}/resolve`)).status).toBe(404);
    expect((await request(app).post(`/admin/trust-requests/${id(5)}/reject`)).status).toBe(409);
  });
});

describe('gates', () => {
  it('a merchant (store_admin) is refused on every route and nothing changes', async () => {
    const as = (r: request.Test) => r.set('x-role', 'store_admin');
    expect((await as(request(app).get('/admin/trust-requests'))).status).toBe(403);
    expect((await as(request(app).get(`/admin/trust-requests/${id(1)}`))).status).toBe(403);
    expect((await as(request(app).post(`/admin/trust-requests/${id(1)}/resolve`))).status).toBe(
      403
    );
    expect((await as(request(app).post(`/admin/trust-requests/${id(1)}/reject`))).status).toBe(403);
    expect(h.rows.find(r => r.id === id(1))!.status).toBe('open');
  });
  it('a super admin without MFA is refused on every route', async () => {
    const no = (r: request.Test) => r.set('x-no-mfa', '1');
    expect((await no(request(app).get('/admin/trust-requests'))).status).toBe(403);
    expect((await no(request(app).post(`/admin/trust-requests/${id(1)}/resolve`))).status).toBe(
      403
    );
    expect(h.rows.find(r => r.id === id(1))!.status).toBe('open');
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('grant helpers close the matching open request', () => {
  it('a protected-address grant resolves every open claim for that address only', async () => {
    const svc = await import('@api/services/trust-requests.service');
    h.rows.push({
      id: id(7),
      kind: 'slug_claim',
      status: 'open',
      storeId: null,
      userId: 'u2',
      slug: 'nike',
      createdAt: new Date(),
    });
    h.rows.push({
      id: id(8),
      kind: 'slug_claim',
      status: 'open',
      storeId: null,
      userId: 'u2',
      slug: 'adidas',
      createdAt: new Date(),
    });
    expect(await svc.closeGrantedRequests({ trustRequest } as any, { slug: ' Nike ' })).toBe(2);
    expect(h.rows.filter(r => r.kind === 'slug_claim').map(r => [r.slug, r.status])).toEqual([
      ['nike', 'resolved'],
      ['nike', 'resolved'],
      ['adidas', 'open'],
    ]);
  });
  it("a plan grant resolves that owner's open store-limit request only", async () => {
    const svc = await import('@api/services/trust-requests.service');
    h.rows.push({
      id: id(9),
      kind: 'store_cap',
      status: 'open',
      storeId: null,
      userId: 'u2',
      createdAt: new Date(),
    });
    expect(await svc.closeGrantedRequests({ trustRequest } as any, { ownerId: U1 })).toBe(1);
    expect(h.rows.find(r => r.id === id(4))!.status).toBe('resolved');
    expect(h.rows.find(r => r.id === id(9))!.status).toBe('open');
  });
});

describe('closeCapRequestOnPlanGrant (PUT /admin/stores/:id/subscription)', () => {
  it("resolves the store owner's open store-limit request; an unknown store closes nothing", async () => {
    const { closeCapRequestOnPlanGrant } = await import('@api/services/trust-grants');
    expect(await closeCapRequestOnPlanGrant('admin-1', S1)).toBe(1);
    expect(h.rows.find(r => r.id === id(4))!.status).toBe('resolved');
    expect(await closeCapRequestOnPlanGrant('admin-1', S2)).toBe(0);
  });
});
