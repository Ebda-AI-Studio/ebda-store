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
      if ('not' in v) return r[k] !== v.not && r[k] !== undefined;
      if ('gte' in v || 'lte' in v)
        return (!('gte' in v) || r[k] >= v.gte) && (!('lte' in v) || r[k] <= v.lte);
    }
    return r[k] === v;
  });
const trustRequest = {
  findMany: async ({ where, take, cursor, skip, orderBy }: any) => {
    const byLimit = !Array.isArray(orderBy) && orderBy?.grantedLimit === 'desc';
    const hit = h.rows
      .filter(r => match(r, where))
      .sort((a, b) =>
        byLimit
          ? b.grantedLimit - a.grantedLimit
          : b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
      );
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
    const res = await request(app)
      .post(`/admin/trust-requests/${id(n)}/resolve`)
      .send(kind === 'store_cap' ? { limit: 5 } : {});
    expect(res.status).toBe(200);
    expect(h.rows.find(r => r.id === id(n))!.status).toBe('resolved');
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trust_request.resolve',
        resourceType: 'trust_request',
        resourceId: id(n),
        userId: 'admin-1',
        details: { kind, status: 'resolved', ...(kind === 'store_cap' ? { grantedLimit: 5 } : {}) },
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
});

describe('RESOLVE of a store-limit request grants the new limit in the same step', () => {
  const url = `/admin/trust-requests/${id(4)}/resolve`;
  it('stores the granted limit on the request, closes it and audits the limit', async () => {
    const res = await request(app).post(url).send({ limit: 6 });
    expect(res.status).toBe(200);
    expect(res.body.data.grantedLimit).toBe(6);
    expect(h.rows.find(r => r.id === id(4))).toMatchObject({ status: 'resolved', grantedLimit: 6 });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ grantedLimit: 6 }) })
    );
  });
  it.each([
    ['no limit', {}],
    ['below the minimum (2)', { limit: 2 }],
    ['above the maximum (21)', { limit: 21 }],
    ['a fraction', { limit: 4.5 }],
    ['a string', { limit: '5' }],
  ])('refuses %s (400) and nothing changes', async (_n, body) => {
    const res = await request(app).post(url).send(body);
    expect(res.status).toBe(400);
    expect(h.rows.find(r => r.id === id(4))).toMatchObject({ status: 'open' });
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('a grant can be revised: raise it, then lower it (3 allowed), each audited, the old rows untouched', async () => {
    expect((await request(app).post(url).send({ limit: 12 })).status).toBe(200);
    h.rows.push({
      id: id(9),
      kind: 'store_cap',
      status: 'open',
      storeId: null,
      userId: U1,
      createdAt: new Date(),
    });
    expect(
      (
        await request(app)
          .post(`/admin/trust-requests/${id(9)}/resolve`)
          .send({ limit: 3 })
      ).status
    ).toBe(200);
    expect(h.rows.find(r => r.id === id(4))!.grantedLimit).toBe(12);
    expect(h.rows.find(r => r.id === id(9))!.grantedLimit).toBe(3);
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ grantedLimit: 3 }) })
    );
  });
  it('a limit on any other decision is refused; reject takes none', async () => {
    expect(
      (
        await request(app)
          .post(`/admin/trust-requests/${id(1)}/resolve`)
          .send({ limit: 5 })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/admin/trust-requests/${id(4)}/reject`)
          .send({ limit: 5 })
      ).status
    ).toBe(400);
    expect((await request(app).post(`/admin/trust-requests/${id(4)}/reject`)).status).toBe(200);
  });
});
