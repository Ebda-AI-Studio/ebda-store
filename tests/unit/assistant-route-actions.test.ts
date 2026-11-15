/**
 * Smart Layer Phase B, apply and undo through the Store assistant routes (plan 4 B7): the same harness as assistant-route.test.ts (real engine, real
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
const announce = makeAnnounce();

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

const propose = async (text = 'new') => {
  configureAssistant({
    ai: scripted(text),
    controls: controls(),
    changeTools: [announce],
  } as never);
  const res = await request(app)
    .post(`/stores/${A}/assistant/turn`)
    .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
  return res.body.data.previews[0] as { previewId: string; policy: string } | undefined;
};
const apply = (id: string, store = A) =>
  request(app).post(`/stores/${store}/assistant/previews/${id}/apply`).send({});
const rowsOf = (t: string) => h.journal!.raw.prepare(`SELECT * FROM ${t}`).all();

beforeEach(() => {
  h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
  h.journal = nodeJournal() as never;
  h.hasDo = true;
  h.store = { text: 'old', v: 1 };
  h.audit.length = 0;
  h.mode = 'act';
});

describe('assistant route: apply and undo (B7)', () => {
  it('a turn builds a preview card and changes nothing', async () => {
    const card = await propose();
    expect(card).toMatchObject({ policy: 'preview' });
    expect(h.store.text).toBe('old');
    expect(h.audit).toEqual([]);
  });

  it('apply in suggest mode is a 409 mode and nothing changes', async () => {
    const card = await propose();
    h.mode = 'suggest';
    const res = await apply(card!.previewId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSISTANT_MODE');
    expect(h.store.text).toBe('old');
  });

  it('apply in act mode changes the store through runAsMerchant (audit "via assistant") and offers undo for 24 h', async () => {
    const card = await propose();
    const res = await apply(card!.previewId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('applied');
    expect(res.body.data.undoUntil).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(h.store.text).toBe('new');
    expect(h.audit[0]).toMatchObject({
      userId: 'u-owner',
      storeId: A,
      action: 'store.announcement_updated',
    });
    expect((h.audit[0]!.details as Record<string, unknown>).actor).toBe('assistant');
  });

  it('with the assistant switched off, apply and undo are refused (403 ASSISTANT_OFF) and read nothing', async () => {
    const card = await propose();
    configureAssistant({
      ai: scripted('x'),
      controls: { ...controls(), mode: async () => 'off' as never },
      changeTools: [announce],
    } as never);
    const res = await apply(card!.previewId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ASSISTANT_OFF');
    const undo = await request(app).post(`/stores/${A}/assistant/applied/${CONV}/undo`).send({});
    expect(undo.status).toBe(403);
    expect(h.store.text).toBe('old');
  });

  it('a second press on the same card applies once', async () => {
    const card = await propose();
    const [a, b] = await Promise.all([apply(card!.previewId), apply(card!.previewId)]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(h.store.v).toBe(2);
  });

  it('stale: the merchant edited it by hand after the preview -> 200 stale with the new card, nothing applied', async () => {
    const card = await propose();
    h.store = { text: 'hand edit', v: 5 };
    const res = await apply(card!.previewId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('stale');
    expect(res.body.data.card.rows[0].before).toBe('hand edit');
    expect(h.store.text).toBe('hand edit');
  });

  it('undo restores the before value; a second undo is a 404', async () => {
    const applied = (await apply((await propose())!.previewId)).body.data.appliedId as string;
    const undo = () => request(app).post(`/stores/${A}/assistant/applied/${applied}/undo`).send({});
    const res = await undo();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('undone');
    expect(h.store.text).toBe('old');
    expect((await undo()).status).toBe(404);
  });

  it('undo with a hand edit in between re-previews instead of writing', async () => {
    const applied = (await apply((await propose())!.previewId)).body.data.appliedId as string;
    h.store = { text: 'newer hand edit', v: 9 };
    const res = await request(app).post(`/stores/${A}/assistant/applied/${applied}/undo`).send({});
    expect(res.body.data.status).toBe('stale');
    expect(h.store.text).toBe('newer hand edit');
  });

  it('another member of the same store cannot apply or undo a card they did not get', async () => {
    const card = await propose();
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    expect((await apply(card!.previewId)).status).toBe(404);
    expect(h.store.text).toBe('old');
  });

  it('a member whose role lacks the route permission never gets a card for it, and nothing is audited', async () => {
    const strict = makeAnnounce({ gate: { permission: 'products:delete' } });
    configureAssistant({ ai: scripted('x'), controls: controls(), changeTools: [strict] } as never);
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    const res = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
    expect(res.body.data.previews).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.store.text).toBe('old');
  });

  it('the kill switch stops an apply after the preview (read at execution time)', async () => {
    const card = await propose();
    configureAssistant({
      ai: scripted('x'),
      changeTools: [announce],
      controls: {
        ...controls(),
        flags: async () => ({
          global: { mode: 'act' as const, kill: true },
          product: {},
          killedTools: [],
        }),
      },
    } as never);
    const res = await apply(card!.previewId);
    expect([403, 409]).toContain(res.status);
    expect(h.store.text).toBe('old');
  });

  it('a confirm-class card cannot be applied here (needs its approval)', async () => {
    const dear = makeAnnounce({ policy: 'confirm' });
    configureAssistant({ ai: scripted('x'), controls: controls(), changeTools: [dear] } as never);
    const t = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
    const card = t.body.data.previews[0];
    expect(card.policy).toBe('confirm');
    expect(t.body.data.approvals).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain(t.body.data.approvals[0].token); // the token is out of band, never in the card
    const res = await apply(card.previewId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NEEDS_CONFIRM');
    expect(h.store.text).toBe('old');
    expect(rowsOf('sl_applied')).toEqual([]);
  });
});
