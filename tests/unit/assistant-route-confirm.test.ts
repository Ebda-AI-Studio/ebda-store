/**
 * Smart Layer Phase B, confirm and reject through the Store assistant routes (plan 4 C2): the same harness as assistant-route.test.ts (real engine, real
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

let grant: { approvalId: string; token: string } | undefined;
const propose = async (text = 'new', convo = CONV) => {
  configureAssistant({
    ai: scripted(text),
    controls: controls(),
    changeTools: [announce],
  } as never);
  const res = await request(app)
    .post(`/stores/${A}/assistant/turn`)
    .send({ conversationId: convo, text: 'set announcement bar text', locale: 'ar' });
  grant = res.body.data.approvals?.[0];
  return res.body.data.previews[0] as
    | { previewId: string; policy: string; approvalId: string; reasons: string[] }
    | undefined;
};
const confirm = (id: string, token: string, store = A) =>
  request(app).post(`/stores/${store}/assistant/approvals/${id}/confirm`).send({ token });
const rowsOf = (t: string) =>
  h.journal!.raw.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
  h.journal = nodeJournal() as never;
  h.hasDo = true;
  h.store = { text: 'old', v: 1 };
  h.audit.length = 0;
  h.mode = 'act';
  grant = undefined;
});

describe('assistant route: confirm and reject (C2)', () => {
  it('a 30-item price change is ONE confirm card with the bulk and price reasons, an approval id, and the token only out of band', async () => {
    const card = await propose();
    expect(card).toMatchObject({ policy: 'confirm' });
    expect(card!.reasons).toEqual(expect.arrayContaining(['declared', 'money', 'bulk', 'price']));
    expect(card!.approvalId).toBe(grant!.approvalId);
    expect(JSON.stringify(card)).not.toContain(grant!.token);
    expect(JSON.stringify(rowsOf('sl_turns'))).not.toContain(grant!.token);
    expect(JSON.stringify(rowsOf('sl_audit'))).not.toContain(grant!.token);
    expect(h.store.text).toBe('old');
  });

  it('pressing confirm with the token applies it (audit via assistant) and returns the undo deadline', async () => {
    await propose();
    const res = await confirm(grant!.approvalId, grant!.token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('applied');
    expect(h.store.text).toBe('new');
    expect((h.audit[0]!.details as Record<string, unknown>).actor).toBe('assistant');
    expect(rowsOf('sl_decisions').map(r => r.decision)).toEqual(['confirmed']);
  });

  it('a typed "yes" applies nothing: another turn with no token changes no state and no approval is used', async () => {
    await propose();
    configureAssistant({
      ai: { run: scripted('x').run },
      controls: controls(),
      changeTools: [announce],
    } as never);
    const yes = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'yes', locale: 'en' });
    expect(yes.status).toBe(200);
    expect(h.store.text).toBe('old');
    expect(rowsOf('sl_applied')).toEqual([]);
    expect(rowsOf('sl_approvals').filter(r => r.status === 'used')).toEqual([]);
  });

  it('a wrong token does not apply and does not burn the real one', async () => {
    await propose();
    const bad = await confirm(grant!.approvalId, 'x'.repeat(43));
    expect(bad.status).toBe(409);
    expect(h.store.text).toBe('old');
    expect((await confirm(grant!.approvalId, grant!.token)).status).toBe(200);
  });

  it('two parallel presses apply once', async () => {
    await propose();
    const [a, b] = await Promise.all([
      confirm(grant!.approvalId, grant!.token),
      confirm(grant!.approvalId, grant!.token),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.store.v).toBe(2);
    expect(rowsOf('sl_applied')).toHaveLength(1);
  });

  it('confirm after a role downgrade is refused (403) and logged rejected:permission; nothing changes and the approval is dead', async () => {
    const strict = makeAnnounce({ policy: 'confirm', gate: { permission: 'products:delete' } });
    configureAssistant({
      ai: scripted('new'),
      controls: controls(),
      changeTools: [strict],
    } as never);
    const t = await request(app)
      .post(`/stores/${A}/assistant/turn`)
      .send({ conversationId: CONV, text: 'set announcement bar text', locale: 'ar' });
    const g = t.body.data.approvals[0];
    expect(g).toBeTruthy();
    h.user = { userId: 'u-owner', role: 'staff', storeId: A }; // demoted while the card was open
    const res = await confirm(g.approvalId, g.token);
    expect(res.status).toBe(403);
    expect(h.store.text).toBe('old');
    expect(rowsOf('sl_decisions').map(r => r.decision)).toEqual(['rejected:permission']);
    h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
    expect((await confirm(g.approvalId, g.token)).status).toBe(409); // burned
  });

  it('a hand edit after the card re-issues a fresh approval instead of applying', async () => {
    await propose();
    h.store = { text: 'hand edit', v: 7 };
    const res = await confirm(grant!.approvalId, grant!.token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('stale');
    expect(res.body.data.card.approvalId).toBeTruthy();
    expect(res.body.data.approvals).toHaveLength(1);
    expect(h.store.text).toBe('hand edit');
    const again = await confirm(
      res.body.data.approvals[0].approvalId,
      res.body.data.approvals[0].token
    );
    expect(again.body.data.status).toBe('applied');
  });

  it('reject records the decision and kills the token', async () => {
    await propose();
    const r = await request(app)
      .post(`/stores/${A}/assistant/approvals/${grant!.approvalId}/reject`)
      .send({});
    expect(r.status).toBe(200);
    expect(rowsOf('sl_decisions').map(x => x.decision)).toEqual(['rejected']);
    expect((await confirm(grant!.approvalId, grant!.token)).status).toBe(409);
    expect(h.store.text).toBe('old');
  });

  it('another member of the store cannot confirm or reject a card they did not get', async () => {
    await propose();
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    expect((await confirm(grant!.approvalId, grant!.token)).status).toBe(403);
    const r = await request(app)
      .post(`/stores/${A}/assistant/approvals/${grant!.approvalId}/reject`)
      .send({});
    expect(r.status).toBe(403);
    expect(h.store.text).toBe('old');
  });

  it('the confirm route is not a tool and not reachable through apply: apply on a confirm card says NEEDS_CONFIRM', async () => {
    const card = await propose();
    const res = await request(app)
      .post(`/stores/${A}/assistant/previews/${card!.previewId}/apply`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NEEDS_CONFIRM');
  });

  it('the kill switch stops a confirm and does not burn the token', async () => {
    await propose();
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
    expect([403, 409]).toContain((await confirm(grant!.approvalId, grant!.token)).status);
    expect(h.store.text).toBe('old');
    configureAssistant({
      ai: scripted('x'),
      changeTools: [announce],
      controls: controls(),
    } as never);
    expect((await confirm(grant!.approvalId, grant!.token)).status).toBe(200);
  });
});
