/**
 * Routes of the lifecycle emails: the merchant's log (auth chain stubbed) and the login-free
 * unsubscribe link (GET only confirms, POST does it, a bad token is a 404 that does nothing).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({ optOut: vi.fn(), list: vi.fn(), testSend: vi.fn() }));

vi.mock('@api/config', () => ({
  config: {
    jwtSecret: 'j',
    encryptionKey: 'test-encryption-key-0123456789abcdef',
    apiUrl: 'https://api.ebda.app',
  },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: req.headers['x-role'] ?? 'store_admin' };
    next();
  },
  // Same contract as the real one: a role outside the list is a 403.
  authorize:
    (...roles: string[]) =>
    (req: any, res: any, next: any) =>
      roles.includes(req.user.role) ? next() : res.status(403).json({ success: false }),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  publicLimiter: (_req: any, _res: any, next: any) => next(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: vi.fn(),
}));
vi.mock('@api/services/lifecycle-emails.service', () => ({
  optOut: m.optOut,
  listLifecycleLog: m.list,
  sendLifecycleTestEmail: m.testSend,
}));

const STORE = '11111111-1111-4111-8111-111111111111';
let app: Express;

beforeAll(async () => {
  const { default: admin } = await import('@api/routes/lifecycle-emails.routes');
  const { default: pub } = await import('@api/routes/lifecycle-emails-public.routes');
  const { signLifecycleUnsubscribeToken } = await import('@api/lib/lifecycle-unsubscribe-token');
  app = express();
  app.use(express.json());
  app.use('/stores/:storeId/lifecycle-emails', admin);
  app.use('/public/lifecycle-emails', pub);
  (app as any).token = signLifecycleUnsubscribeToken(STORE);
});

beforeEach(() => {
  m.optOut.mockReset();
  m.list.mockReset();
  m.testSend.mockReset();
});

describe('GET /stores/:storeId/lifecycle-emails', () => {
  it('returns the log for the store in the URL', async () => {
    m.list.mockResolvedValue({ optedOut: false, entries: [] });
    const res = await request(app).get(`/stores/${STORE}/lifecycle-emails`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { optedOut: false, entries: [] } });
    expect(m.list).toHaveBeenCalledWith(STORE);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // The setup emails page is the owner's (and platform support's): staff cannot read it by URL either.
  it('is 403 for staff and never reads the log', async () => {
    const res = await request(app).get(`/stores/${STORE}/lifecycle-emails`).set('x-role', 'staff');
    expect(res.status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('is 200 for the store owner (store_admin) and for super_admin', async () => {
    m.list.mockResolvedValue({ optedOut: false, entries: [] });
    for (const role of ['store_admin', 'super_admin']) {
      const res = await request(app).get(`/stores/${STORE}/lifecycle-emails`).set('x-role', role);
      expect(res.status, role).toBe(200);
    }
  });
});

describe('POST /stores/:storeId/lifecycle-emails/test-send', () => {
  const post = (body: unknown) =>
    request(app)
      .post(`/stores/${STORE}/lifecycle-emails/test-send`)
      .send(body as object);

  it('sends to the owner for the caller and names only the owner address back', async () => {
    m.testSend.mockResolvedValue({ status: 'sent', to: 'owner@example.com' });
    const res = await post({ kind: 'trial_recap' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { kind: 'trial_recap', to: 'owner@example.com' },
    });
    expect(m.testSend).toHaveBeenCalledWith(STORE, 'trial_recap', 'u1');
  });

  it('a body cannot choose a recipient: unknown keys and unknown kinds are rejected before any send', async () => {
    for (const body of [{ kind: 'trial_recap', to: 'victim@example.com' }, { kind: 'nope' }, {}]) {
      const res = await post(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(m.testSend).not.toHaveBeenCalled();
  });

  it.each([
    ['not_owner', 403, 'OWNER_ONLY'],
    ['not_found', 404, 'STORE_NOT_FOUND'],
    ['no_recipient', 409, 'NO_OWNER_EMAIL'],
    ['failed', 502, 'ENQUEUE_FAILED'],
  ])('%s -> %i %s, never a success', async (status, code, errCode) => {
    m.testSend.mockResolvedValue({ status, reason: 'x' });
    const res = await post({ kind: 'add_products' });
    expect(res.status).toBe(code);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(errCode);
  });
});

describe('public unsubscribe', () => {
  const url = () => `/public/lifecycle-emails/unsubscribe?token=${(app as any).token}`;

  it('GET shows a confirm page and unsubscribes nobody (link scanners prefetch GETs)', async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post"');
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
    expect(m.optOut).not.toHaveBeenCalled();
  });

  it('POST performs it for the store named by the signed token', async () => {
    m.optOut.mockResolvedValue(undefined);
    const res = await request(app).post(url());
    expect(res.status).toBe(200);
    expect(m.optOut).toHaveBeenCalledWith(STORE);
  });

  it('a tampered or missing token is a 404 and does nothing', async () => {
    const bad = `/public/lifecycle-emails/unsubscribe?token=${STORE}.${'A'.repeat(43)}`;
    expect((await request(app).get(bad)).status).toBe(404);
    expect((await request(app).post(bad)).status).toBe(404);
    expect((await request(app).post('/public/lifecycle-emails/unsubscribe')).status).toBe(404);
    expect(m.optOut).not.toHaveBeenCalled();
  });
});
