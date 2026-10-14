/**
 * WHATSAPP-OFF-1: every WhatsApp Business API admin route refuses with the
 * house feature-gate error (403 FEATURE_DISABLED, feature:'whatsapp') while the
 * store's `whatsapp` feature is OFF, and passes the gate once a per-store
 * override turns it ON.
 *
 * The route list is ENUMERATED from each router's own stack, so a route added
 * to one of these routers later without a gate fails here instead of shipping
 * ungated. The WBS-facing bridge endpoints and the Inngest senders have their
 * own tests (contract-wbs-bridge, order-whatsapp-notify).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express, type Router } from 'express';
import request from 'supertest';

const { mockIsFeatureEnabled } = vi.hoisted(() => ({ mockIsFeatureEnabled: vi.fn() }));

vi.mock('@force/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@force/database')>()),
  prisma: {},
  withStore: (_id: string, fn: (tx: unknown) => unknown) => fn({}),
  withMoneyTx: (_p: unknown, fn: (tx: unknown) => unknown) => fn({}),
  hasTenantContext: () => true,
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: mockIsFeatureEnabled },
}));
vi.mock('@api/services/plan-entitlements', () => ({ getEntitlements: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE_ID = '11111111-1111-4111-8111-111111111111';

interface RouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
}

/** Every concrete route on a router (non-recursive: these routers are flat). */
function enumerate(router: Router): RouteSpec[] {
  const out: RouteSpec[] = [];
  for (const layer of (router as any).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method as RouteSpec['method'], path: layer.route.path });
    }
  }
  return out;
}

const concrete = (path: string) =>
  path.replace(':id', STORE_ID).replace(':storeId', STORE_ID).replace(':orderId', 'o1');

async function load(modulePath: string) {
  return (await import(modulePath)).default as Router;
}

// router module → mount prefix used in apps/api/src/routes/index.ts
const MOUNTS: Array<{ name: string; module: string; prefix: string }> = [
  { name: 'wbs-integration', module: '@api/routes/wbs-integration.routes', prefix: '/stores' },
  {
    name: 'wa-templates',
    module: '@api/routes/wa-templates.routes',
    prefix: `/stores/${STORE_ID}/wa-templates`,
  },
  { name: 'bot-analytics', module: '@api/routes/bot-analytics.routes', prefix: '/stores' },
  {
    name: 'payment-links',
    module: '@api/routes/payment-links.routes',
    prefix: `/stores/${STORE_ID}/payment-links`,
  },
];

describe.each(MOUNTS)('WHATSAPP-OFF-1 — $name routes', ({ module, prefix }) => {
  let app: Express;
  let routes: RouteSpec[];

  beforeAll(async () => {
    const router = await load(module);
    routes = enumerate(router);
    app = express();
    app.use(express.json());
    // The real mount is `/stores/:id/<x>`; mergeParams routers read :id from it.
    app.use(prefix.includes(STORE_ID) ? prefix.replace(STORE_ID, ':id') : prefix, router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err?.status ?? 500).json({ success: false, error: 'handler-reached' });
    });
  });

  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('enumerates at least one route (the walk itself works)', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every route answers 403 FEATURE_DISABLED when whatsapp is OFF', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    for (const r of routes) {
      const url = prefix.includes(STORE_ID)
        ? concrete(`${prefix}${r.path === '/' ? '' : r.path}`)
        : concrete(`${prefix}${r.path}`);
      const res = await (request(app) as any)[r.method](url).send({});
      expect(res.status, `${r.method.toUpperCase()} ${url}`).toBe(403);
      expect(res.body, `${r.method.toUpperCase()} ${url}`).toMatchObject({
        success: false,
        code: 'FEATURE_DISABLED',
        feature: 'whatsapp',
      });
    }
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(STORE_ID, 'whatsapp');
  });

  it('with the per-store override ON, no route is stopped by the feature gate', async () => {
    mockIsFeatureEnabled.mockImplementation(async (_s: string, key: string) => key === 'whatsapp');
    for (const r of routes) {
      const url = prefix.includes(STORE_ID)
        ? concrete(`${prefix}${r.path === '/' ? '' : r.path}`)
        : concrete(`${prefix}${r.path}`);
      const res = await (request(app) as any)[r.method](url).send({});
      expect(res.body?.code, `${r.method.toUpperCase()} ${url}`).not.toBe('FEATURE_DISABLED');
    }
  });
});

describe('WHATSAPP-OFF-1 — notification channel routes', () => {
  let app: Express;

  beforeAll(async () => {
    vi.doMock('@api/services/notification-config.service', () => ({
      notificationConfigService: {
        upsertConfig: vi.fn().mockResolvedValue({ credentials: {} }),
        maskCredentials: (c: unknown) => c,
        testConnection: vi.fn().mockResolvedValue({ ok: true }),
      },
    }));
    const router = await load('@api/routes/notification.routes');
    app = express();
    app.use(express.json());
    app.use('/stores', router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ success: false, error: String(err?.message ?? err) });
    });
  });

  beforeEach(() => mockIsFeatureEnabled.mockReset());

  const PUT = `/stores/${STORE_ID}/notifications/configs/whatsapp`;
  const TEST = `/stores/${STORE_ID}/notifications/test/whatsapp`;
  const BODY = { provider: 'meta', credentials: {}, enabled: true };

  it('PUT configs/whatsapp and POST test/whatsapp are 403 FEATURE_DISABLED when OFF', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    for (const res of [
      await request(app).put(PUT).send(BODY),
      await request(app).post(TEST).send({}),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FEATURE_DISABLED', feature: 'whatsapp' });
    }
  });

  it('PUT configs/whatsapp passes the gate with the per-store override ON', async () => {
    mockIsFeatureEnabled.mockImplementation(async (_s: string, key: string) => key === 'whatsapp');
    const res = await request(app).put(PUT).send(BODY);
    expect(res.status).toBe(200);
  });
});
