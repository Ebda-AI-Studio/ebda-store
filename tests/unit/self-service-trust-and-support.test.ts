/**
 * SELF-SERVICE gaps A13 + A14 + A16: a merchant reads why their store was suspended and files ONE open appeal,
 * sends a support request to Ebda staff from inside the product (5 per store per day), and claims a protected
 * brand slug or asks for a higher daily store cap with evidence. Staff keep every decision (the override).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const m = vi.hoisted(() => ({
  rows: [] as Row[],
  store: { status: 'suspended', billingSuspendedReason: null as string | null } as Row | null,
  enqueue: vi.fn(),
  audit: vi.fn(),
  seq: 0,
}));

const matches = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'gte' in v) return r[k] >= v.gte;
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
    return r[k] === v;
  });
const trustRequest = {
  create: async ({ data }: { data: Row }) => {
    const dup =
      (data.kind === 'suspension_appeal' &&
        m.rows.some(
          r => r.kind === data.kind && r.storeId === data.storeId && r.status === 'open'
        )) ||
      (data.kind === 'slug_claim' &&
        m.rows.some(
          r =>
            r.kind === data.kind &&
            r.userId === data.userId &&
            r.slug === data.slug &&
            r.status === 'open'
        )) ||
      (data.kind === 'store_cap' &&
        m.rows.some(r => r.kind === data.kind && r.userId === data.userId && r.status === 'open'));
    if (dup) throw Object.assign(new Error('unique'), { code: 'P2002' });
    const row = { id: `t${++m.seq}`, status: 'open', createdAt: new Date(), ...data };
    m.rows.push(row);
    return row;
  },
  findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
    const hit = m.rows.filter(r => matches(r, where));
    return (orderBy ? [...hit].reverse() : hit)[0] ?? null;
  },
  count: async ({ where }: { where?: Row }) => m.rows.filter(r => matches(r, where)).length,
  updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
    const hit = m.rows.filter(r => matches(r, where));
    hit.forEach(r => Object.assign(r, data));
    return { count: hit.length };
  },
};
const fakePrisma = {
  trustRequest,
  store: { findUnique: async () => m.store },
};

vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return {
    ...real,
    prisma: fakePrisma,
    withUser: async (_u: string, fn: (tx: any) => unknown) => fn(fakePrisma),
  };
});
vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, res: any, next: any) => {
      if (req.header('x-anon')) return res.status(401).json({ success: false });
      req.user = {
        userId: req.header('x-user') ?? 'u1',
        email: 'owner@example.com',
        role: req.header('x-role') ?? 'store_admin',
      };
      next();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/require-verified-email', () => ({
  requireVerifiedEmail: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (req: any, res: any, next: any) =>
    req.params.storeId === 'store-a' ? next() : res.status(404).json({ success: false }),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return { ...real, auditLog: m.audit, writeLimiter: (_q: any, _s: any, n: any) => n() };
});
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@api/services/email-queue.service', () => ({ emailQueue: { enqueue: m.enqueue } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: async () => undefined }));

let app: Express;
beforeAll(async () => {
  const support = (await import('@api/routes/support.routes')).default;
  const onboarding = (await import('@api/routes/onboarding.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', support);
  app.use('/onboarding', onboarding);
  app.use(errorHandler as any);
});
beforeEach(() => {
  m.rows.length = 0;
  m.seq = 0;
  m.store = { status: 'suspended', billingSuspendedReason: null };
  m.enqueue.mockReset().mockResolvedValue(undefined);
  m.audit.mockReset().mockResolvedValue(undefined);
});

describe('A13 suspension reason and appeal', () => {
  const seedReason = () =>
    m.rows.push({
      id: 'r0',
      kind: 'suspension',
      storeId: 'store-a',
      message: 'Selling counterfeit goods',
      status: 'open',
      createdAt: new Date('2026-11-01'),
    });

  it('a suspended store reads the reason staff recorded', async () => {
    seedReason();
    const res = await request(app).get('/stores/store-a/suspension');
    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe('Selling counterfeit goods');
    expect(res.body.data.kind).toBe('policy');
    expect(res.body.data.appeal).toBeNull();
  });

  it('a store that is not suspended answers 404', async () => {
    m.store = { status: 'active', billingSuspendedReason: null };
    expect((await request(app).get('/stores/store-a/suspension')).status).toBe(404);
    const res = await request(app).post('/stores/store-a/suspension/appeal').send({ message: 'x' });
    expect(res.status).toBe(404);
  });

  it("another store's id answers 404 and reads nothing", async () => {
    seedReason();
    expect((await request(app).get('/stores/store-b/suspension')).status).toBe(404);
  });

  it('files one appeal, then the second is 409; staff are emailed once and an audit row is written', async () => {
    seedReason();
    const first = await request(app)
      .post('/stores/store-a/suspension/appeal')
      .send({ message: 'These are my own products, here are the invoices.' });
    expect(first.status).toBe(201);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.suspension_appeal', storeId: 'store-a' })
    );
    const second = await request(app)
      .post('/stores/store-a/suspension/appeal')
      .send({ message: 'again' });
    expect(second.status).toBe(409);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    const read = await request(app).get('/stores/store-a/suspension');
    expect(read.body.data.appeal.status).toBe('open');
  });

  it('refuses an empty or over-long message (Zod at the edge)', async () => {
    seedReason();
    expect(
      (await request(app).post('/stores/store-a/suspension/appeal').send({ message: '' })).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/stores/store-a/suspension/appeal')
          .send({ message: 'x'.repeat(1001) })
      ).status
    ).toBe(400);
  });

  it('a billing suspension shows its billing reason and cannot be appealed as a policy case', async () => {
    m.store = { status: 'suspended', billingSuspendedReason: 'unpaid' };
    const read = await request(app).get('/stores/store-a/suspension');
    expect(read.body.data).toMatchObject({ kind: 'billing', reason: 'unpaid' });
    const res = await request(app)
      .post('/stores/store-a/suspension/appeal')
      .send({ message: 'hi' });
    expect(res.status).toBe(409);
  });
});

describe('A14 support request', () => {
  const body = {
    topic: 'billing',
    message: 'I was charged twice',
    pageUrl: '/stores/store-a/billing',
  };

  it('stores a valid request and emails the support inbox once', async () => {
    const res = await request(app).post('/stores/store-a/support-requests').send(body);
    expect(res.status).toBe(201);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ kind: 'support', storeId: 'store-a', userId: 'u1' });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0][1].replyTo).toBe('owner@example.com');
  });

  it('the sixth request in a day is 429 and nothing more is stored or sent', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/stores/store-a/support-requests').send(body)).status).toBe(
        201
      );
    }
    const sixth = await request(app).post('/stores/store-a/support-requests').send(body);
    expect(sixth.status).toBe(429);
    expect(m.rows).toHaveLength(5);
    expect(m.enqueue).toHaveBeenCalledTimes(5);
  });

  it('requests older than a day do not count toward the cap', async () => {
    for (let i = 0; i < 5; i++)
      m.rows.push({
        kind: 'support',
        storeId: 'store-a',
        createdAt: new Date(Date.now() - 25 * 3600_000),
      });
    expect((await request(app).post('/stores/store-a/support-requests').send(body)).status).toBe(
      201
    );
  });

  it('refuses an unknown topic, an empty message and a javascript: page url', async () => {
    const post = (b: object) => request(app).post('/stores/store-a/support-requests').send(b);
    expect((await post({ ...body, topic: 'nope' })).status).toBe(400);
    expect((await post({ ...body, message: '' })).status).toBe(400);
    expect((await post({ ...body, pageUrl: 'javascript:alert(1)' })).status).toBe(400);
  });

  it("another store's id answers 404 and stores nothing", async () => {
    const res = await request(app).post('/stores/store-b/support-requests').send(body);
    expect(res.status).toBe(404);
    expect(m.rows).toHaveLength(0);
  });

  it('a request that cannot be emailed is still stored (the row is the record)', async () => {
    m.enqueue.mockRejectedValue(new Error('smtp down'));
    const res = await request(app).post('/stores/store-a/support-requests').send(body);
    expect(res.status).toBe(201);
    expect(m.rows).toHaveLength(1);
  });
});

describe('A16 slug claim and store cap request', () => {
  const claim = {
    slug: 'nike',
    evidence: 'I am the brand owner, trademark registration attached.',
  };

  it('stores a pending claim for a protected slug; staff are told once', async () => {
    const res = await request(app).post('/onboarding/slug-claims').send(claim);
    expect(res.status).toBe(201);
    expect(m.rows[0]).toMatchObject({
      kind: 'slug_claim',
      slug: 'nike',
      userId: 'u1',
      status: 'open',
    });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a duplicate open claim for the same slug is 409', async () => {
    await request(app).post('/onboarding/slug-claims').send(claim);
    const dup = await request(app).post('/onboarding/slug-claims').send(claim);
    expect(dup.status).toBe(409);
    expect(m.rows).toHaveLength(1);
  });

  it('a slug that is not protected is refused (nothing to claim)', async () => {
    const res = await request(app)
      .post('/onboarding/slug-claims')
      .send({ ...claim, slug: 'my-little-shop-123' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('SLUG_NOT_PROTECTED');
    expect(m.rows).toHaveLength(0);
  });

  it('unauthenticated is 401', async () => {
    const res = await request(app).post('/onboarding/slug-claims').set('x-anon', '1').send(claim);
    expect(res.status).toBe(401);
  });

  it('requires evidence', async () => {
    const res = await request(app).post('/onboarding/slug-claims').send({ slug: 'nike' });
    expect(res.status).toBe(400);
  });

  it('stores a daily store-cap request with evidence; a second open one is 409', async () => {
    const body = {
      message: 'I run 12 branches and open them all this week.',
      evidenceUrl: 'https://example.com/proof',
    };
    const first = await request(app).post('/onboarding/store-cap-requests').send(body);
    expect(first.status).toBe(201);
    expect(m.rows[0]).toMatchObject({ kind: 'store_cap', userId: 'u1' });
    const second = await request(app).post('/onboarding/store-cap-requests').send(body);
    expect(second.status).toBe(409);
  });
});

describe('staff side of A13 (the decision stays with the super admin)', () => {
  it('suspending records the reason the merchant reads; reactivating resolves the open appeal', async () => {
    const svc = await import('@api/services/trust-requests.service');
    const db = fakePrisma as any;
    await svc.recordSuspension(db, 'store-a', { userId: 'admin' }, 'Counterfeit goods');
    expect((await request(app).get('/stores/store-a/suspension')).body.data.reason).toBe(
      'Counterfeit goods'
    );
    await request(app).post('/stores/store-a/suspension/appeal').send({ message: 'please review' });
    await svc.closeAppealsOnReactivation(db, 'store-a');
    const appeal = m.rows.find(r => r.kind === 'suspension_appeal');
    expect(appeal?.status).toBe('resolved');
  });

  it('the super-admin status route is wired to both (a merchant route never resolves anything)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('apps/api/src/routes/store.routes.ts', 'utf8');
    expect(src).toContain('recordSuspension(trustDb');
    expect(src).toContain('closeAppealsOnReactivation(trustDb');
    const merchant = fs.readFileSync('apps/api/src/routes/support.routes.ts', 'utf8');
    expect(merchant).not.toContain('closeAppealsOnReactivation');
    expect(merchant).not.toMatch(/status:\s*'resolved'/);
  });
});
