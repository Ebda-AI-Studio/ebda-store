/**
 * Smart Layer Phase B, impersonation on every Store assistant route (review of #793: an impersonated support session must be refused like the admin routes, ruling FP-3): the same harness as assistant-route.test.ts (real engine, real
 * journal SQL, scripted model, mocked edges) with one real `change()` tool, so the route, the engine journal, runAsMerchant and the tool all run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { nodeJournal } from '../helpers/smart-layer-node-sql';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  user: null as null | { userId: string; role: string; storeId: string },
  journal: null as null | {
    call: (op: string, args: unknown[]) => Promise<unknown>;
    raw: { prepare(q: string): { all(): unknown[] } };
  },
  hasDo: true,
  setMode: vi.fn(),
  flagsWritten: [] as Array<[string, unknown]>,
  store: { text: 'old', v: 1 },
  audit: [] as Array<Record<string, unknown>>,
  mode: 'act' as 'suggest' | 'act',
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (
    req: { user?: { impersonatedBy?: string } },
    res: { status(n: number): { json(b: unknown): void } },
    next: () => void
  ) =>
    req.user?.impersonatedBy
      ? res.status(403).json({ success: false, error: { code: 'IMPERSONATION_FORBIDDEN' } })
      : next(),
  authenticate: (
    req: { user?: unknown; headers: Record<string, string | undefined> },
    res: { status(n: number): { json(b: unknown): void } },
    next: () => void
  ) => {
    if (!h.user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    req.user = h.user;
    next();
  },
  authorize:
    (...roles: string[]) =>
    (
      req: { user?: { role: string } },
      res: { status(n: number): { json(b: unknown): void } },
      next: () => void
    ) =>
      req.user && roles.includes(req.user.role)
        ? next()
        : res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } }),
}));
// Membership exactly as the real guard decides it for these roles: a store_admin or staff belongs to ONE store (their token's); super_admin to all.
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _r: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (
    req: { user: { role: string; storeId: string }; params: Record<string, string> },
    res: { status(n: number): { json(b: unknown): void } },
    next: () => void
  ) =>
    req.user.role === 'super_admin' || req.user.storeId === req.params.storeId
      ? next()
      : res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } }),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(async () => undefined),
  writeLimiter: (_q: unknown, _r: unknown, n: () => void) => n(),
}));
vi.mock('@api/lib/repo-factory', async () => {
  const { AppError } = await import('@api/middleware/error-handler');
  return {
    storeSmartLayer: async () => {
      if (!h.hasDo) throw new AppError(503, 'ASSISTANT_UNAVAILABLE', 'not on the durable object');
      return h.journal!.call;
    },
    storeDb: async () => ({}),
  };
});
vi.mock('@api/services/store.service', () => ({
  StoreService: {
    getById: vi.fn(async () => ({ id: 'x' })),
    setAssistantMode: (...a: unknown[]) => h.setMode(...a),
  },
}));
vi.mock('@api/smart-layer/controls', async orig => ({
  ...(await orig<typeof import('@api/smart-layer/controls')>()),
  readPlatformFlags: vi.fn(async () => ({ global: {}, product: {}, killedTools: [] })),
  setPlatformFlag: vi.fn(async (k: string, v: unknown) => void h.flagsWritten.push([k, v])),
}));
vi.mock('@api/smart-layer/merchant-read', () => ({
  ReadForbidden: class ReadForbidden extends Error {},
  callMerchantRead: vi.fn(),
  READ_PERMISSIONS: {},
}));
vi.mock('@api/services/plan.service', () => ({ planService: { listPlans: async () => [] } }));
vi.mock('@api/services/setup-guide.service', () => ({
  SetupGuideService: { get: async () => ({}) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@api/services/ai.service', () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn(async () => undefined) }));
vi.mock('@api/lib/store-ai-switch', () => ({ isStoreAiEnabled: vi.fn(async () => true) }));
vi.mock('@api/lib/search/embedding-provider', () => ({ getEmbeddingProvider: () => null }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));

vi.mock('@api/lib/definer', () => ({
  insertAuditLog: async (r: Record<string, unknown>) => void h.audit.push(r),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));

import { assistantRoutes, configureAssistant } from '@api/routes/assistant.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { change, f, shape, row, pair } from '@api/smart-layer/tools/kit';

const makeAnnounce = (over: Record<string, unknown> = {}) =>
  change<{ text: string }>({
    name: 'announcement_set',
    capabilityId: 'store.announcement',
    description: 'Set the announcement bar text of the store',
    schema: shape({ text: f.str('the new announcement text', { max: 200 }) }, ['text']),
    undo: 'reversible',
    gate: { permission: 'store:settings' },
    audit: { action: 'store.announcement_updated', resourceType: 'store' },
    state: async () => ({ ...h.store }),
    describe: (_c, a, st) => ({
      summary: pair('هغيّر شريط الإعلان.', 'I will change the announcement bar.'),
      rows: [row('نص الشريط', 'Bar text', (st as typeof h.store).text, a.text)],
      affectedCount: 1,
      restore: { text: (st as typeof h.store).text },
    }),
    run: async (_c, a) => {
      h.store = { text: a.text, v: h.store.v + 1 };
    },
    inverse: (_a, restore) => ({ tool: 'announcement_set', args: restore }),
    ...over,
  } as never);
const announce = makeAnnounce({
  policy: 'confirm',
  money: true,
  describe: (_c: unknown, a: { text: string }, st: { text: string }) => ({
    summary: pair('هغيّر السعر.', 'I will change the price.'),
    rows: [row('السعر', 'Price', st.text, a.text)],
    affectedCount: 30,
    changesPrice: true,
    restore: { text: st.text },
  }),
});

const controls = () => ({
  flags: async () => ({ global: { mode: 'act' as const }, product: {}, killedTools: [] }),
  mode: async () => h.mode,
  aiOn: async () => true,
});
const scripted = (text: string) => {
  let i = 0;
  return {
    run: async (_m: string, inputs: Record<string, unknown>) => {
      const sys = ((inputs.messages as Array<{ content?: string }>)[0]?.content ?? '') as string;
      if (sys.includes('Classify the merchant message'))
        return {
          choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      const first = i++ === 0;
      return {
        choices: [
          {
            message: first
              ? {
                  content: null,
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'announcement_set', arguments: JSON.stringify({ text }) },
                    },
                  ],
                }
              : { content: 'جهزت المعاينة.' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
  };
};

const app = express();
app.use(express.json());
app.use('/stores/:storeId/assistant', assistantRoutes);
app.use(errorHandler);

const IMP = { userId: 'u-owner', role: 'store_admin', storeId: A, impersonatedBy: 'support-1' };
const OWNER = { userId: 'u-owner', role: 'store_admin', storeId: A };
const rowsOf = (t: string) =>
  h.journal!.raw.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  h.user = { ...OWNER };
  h.journal = nodeJournal() as never;
  h.hasDo = true;
  h.store = { text: 'old', v: 1 };
  h.audit.length = 0;
  h.mode = 'act';
  configureAssistant({
    ai: scripted('new'),
    controls: controls(),
    changeTools: [announce],
  } as never);
});

describe('impersonated sessions are refused on every assistant route', () => {
  const ID = '44444444-4444-4444-8444-444444444444';
  const calls: Array<[string, (u: string) => request.Test]> = [
    ['status', u => request(app).get(`/stores/${u}/assistant/status`)],
    [
      'turn',
      u =>
        request(app)
          .post(`/stores/${u}/assistant/turn`)
          .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' }),
    ],
    ['conversation', u => request(app).get(`/stores/${u}/assistant/conversations/${CONV}`)],
    [
      'feedback',
      u => request(app).post(`/stores/${u}/assistant/feedback`).send({ turnId: ID, thumb: 'up' }),
    ],
    ['apply', u => request(app).post(`/stores/${u}/assistant/previews/${ID}/apply`).send({})],
    ['undo', u => request(app).post(`/stores/${u}/assistant/applied/${ID}/undo`).send({})],
    [
      'confirm',
      u =>
        request(app)
          .post(`/stores/${u}/assistant/approvals/${ID}/confirm`)
          .send({ token: 'x'.repeat(43) }),
    ],
    ['reject', u => request(app).post(`/stores/${u}/assistant/approvals/${ID}/reject`).send({})],
  ];
  it.each(calls)(
    '%s: 403 IMPERSONATION_FORBIDDEN, no model call and nothing written',
    async (_n, call) => {
      h.user = { ...IMP };
      const res = await call(A);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
      expect(rowsOf('sl_turns')).toEqual([]);
      expect(rowsOf('sl_audit')).toEqual([]);
      expect(rowsOf('sl_applied')).toEqual([]);
      expect(h.audit).toEqual([]);
      expect(h.store.text).toBe('old');
    }
  );

  it('a support session cannot confirm a money card the owner holds the token for', async () => {
    const dear = makeAnnounce({ policy: 'confirm', money: true });
    configureAssistant({ ai: scripted('new'), controls: controls(), changeTools: [dear] } as never);
    const t = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
    const g = t.body.data.approvals[0] as { approvalId: string; token: string };
    expect(g).toBeTruthy();
    h.user = { ...IMP }; // support steals/obtains the token and presses
    const res = await request(app)
      .post(`/stores/${A}/assistant/approvals/${g.approvalId}/confirm`)
      .send({ token: g.token });
    expect(res.status).toBe(403);
    expect(h.store.text).toBe('old');
    expect(rowsOf('sl_decisions')).toEqual([]);
    h.user = { ...OWNER }; // the owner's own press still works: the approval was not burned by the refused attempt
    expect(
      (
        await request(app)
          .post(`/stores/${A}/assistant/approvals/${g.approvalId}/confirm`)
          .send({ token: g.token })
      ).status
    ).toBe(200);
    expect(h.store.text).toBe('new');
  });

  it('the owner (not impersonated) is unaffected on every route', async () => {
    expect((await calls[0]![1](A)).status).toBe(200);
    expect((await calls[1]![1](A)).status).toBe(200);
  });

  it('reject sets Cache-Control no-store like every other assistant response', async () => {
    const dear = makeAnnounce({ policy: 'confirm' });
    configureAssistant({ ai: scripted('new'), controls: controls(), changeTools: [dear] } as never);
    const t = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
    const g = t.body.data.approvals[0] as { approvalId: string };
    const r = await request(app)
      .post(`/stores/${A}/assistant/approvals/${g.approvalId}/reject`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
  });
});
