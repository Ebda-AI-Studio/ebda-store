/**
 * Smart Layer Phase A, the Store assistant route (plan 4 A16): auth, store scoping, the rollout switches, the free cap, the masked journal.
 * Real engine, real journal SQL (node:sqlite behind the same `runSmartLayerOp` the StoreDO runs), a scripted Workers AI binding.
 * Mocked at the edges only: the session (authenticate), the membership check (requireStoreAccess), the store's DO handle and the services behind the tools.
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

import {
  assistantAdminRoutes,
  assistantRoutes,
  configureAssistant,
} from '@api/routes/assistant.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { authenticate } from '@api/middleware/auth';
import { requireStoreAccess } from '@api/middleware/store-access';
import { requireMfaEnrolled } from '@api/middleware/require-mfa';

type Msg = { content?: string };
function scriptedAi(script: Array<{ text?: string; call?: { name: string; args: unknown } }>) {
  const calls: string[] = [];
  const seen: string[] = [];
  let i = 0;
  return {
    calls,
    seen,
    ai: {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        const system = ((inputs.messages as Msg[])[0]?.content ?? '') as string;
        calls.push(system.slice(0, 30));
        seen.push(JSON.stringify(inputs.messages));
        if (system.includes('Classify the merchant message'))
          return {
            choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        const s = script[Math.min(i++, script.length - 1)]!;
        return {
          choices: [
            {
              message: {
                content: s.text ?? null,
                ...(s.call
                  ? {
                      tool_calls: [
                        {
                          id: `c${i}`,
                          type: 'function',
                          function: { name: s.call.name, arguments: JSON.stringify(s.call.args) },
                        },
                      ],
                    }
                  : {}),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    },
  };
}
const HIT = {
  articleId: 'custom-domain',
  title: 'الدومين الخاص',
  url: 'https://help.ebda.app/custom-domain/',
  appPath: '/stores',
  text: 'اكتب دومينك في صفحة الدومين وأضف سجلات الـ DNS.',
  score: 0.9,
};
const help = {
  kv: undefined,
  embed: async (t: string[]) => t.map(() => [0]),
  vectors: {
    upsert: async () => ({}),
    deleteByIds: async () => ({}),
    query: async () => ({
      matches: [
        {
          id: 'a',
          score: 0.9,
          metadata: {
            articleId: HIT.articleId,
            locale: 'ar',
            title: HIT.title,
            url: HIT.url,
            appPath: '',
            text: HIT.text,
          },
        },
      ],
    }),
  },
};
const mode = (m: 'off' | 'answer-only' | 'act' = 'answer-only') => ({
  flags: async () => ({ global: { mode: 'act' as const }, product: {}, killedTools: [] }),
  mode: async () => m,
  aiOn: async () => true,
});

const app = express();
app.use(express.json());
app.use('/stores/:storeId/assistant', assistantRoutes);
app.use('/admin/assistant', assistantAdminRoutes);
app.use(errorHandler);

const turn = (store: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/stores/${store}/assistant/turn`)
    .send({ conversationId: CONV, text: 'ازاي أربط دومين؟', locale: 'ar', ...body });
const rowsOf = (table: string) => h.journal!.raw.prepare(`SELECT * FROM ${table}`).all();

beforeEach(() => {
  h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
  h.journal = nodeJournal() as never;
  h.hasDo = true;
  h.setMode.mockReset();
  h.flagsWritten.length = 0;
  configureAssistant({
    ...scriptedAi([
      { text: 'اكتب دومينك في صفحة الدومين. [[cap:store.domain]] [[help:custom-domain]]' },
    ]),
    help,
    controls: mode(),
  } as never);
});

describe('assistant route: access', () => {
  it('401 without a session', async () => {
    h.user = null;
    expect((await turn(A)).status).toBe(401);
  });

  it('403 for a member of another store: no model call and nothing written for either store (mutation: the membership gate)', async () => {
    const s = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai: s.ai, help, controls: mode() } as never);
    const res = await turn(B); // the token's store is A
    expect(res.status).toBe(403);
    expect(s.calls).toEqual([]);
    expect(rowsOf('sl_turns')).toEqual([]);
    expect(rowsOf('sl_audit')).toEqual([]);
  });

  it('a shopper token is refused before membership is even asked', async () => {
    h.user = { userId: 'u-shopper', role: 'customer', storeId: A };
    expect((await turn(A)).status).toBe(403);
    expect(rowsOf('sl_turns')).toEqual([]);
  });

  it('a store that is not on its Durable Object answers 503, never a fallback', async () => {
    h.hasDo = false;
    expect((await turn(A)).status).toBe(503);
  });

  it('every route sits behind authenticate then requireStoreAccess (structure pin)', () => {
    const handles = (assistantRoutes as unknown as { stack: Array<{ handle: unknown }> }).stack
      .slice(0, 3)
      .map(l => l.handle);
    expect(handles[0]).toBe(authenticate);
    expect(handles[2]).toBe(requireStoreAccess);
    expect(handles).toHaveLength(3); // authenticate, the merchant-role gate, membership
  });
});

describe('assistant route: turns', () => {
  it('mode off (the default) answers 200 status off with no model call', async () => {
    const s = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai: s.ai, help, controls: mode('off') } as never);
    const res = await turn(A);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('off');
    expect(s.calls).toEqual([]);
  });

  it('answer-only: owner and staff both get a grounded answer with a "show me where" segment; the journal is masked', async () => {
    for (const [userId, role] of [
      ['u-owner', 'store_admin'],
      ['u-staff', 'staff'],
    ] as const) {
      h.user = { userId, role, storeId: A };
      const res = await turn(A, { text: 'ازاي أربط دومين؟ رقمي 01012345678' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('answered');
      expect(res.body.data.segments.find((x: { kind: string }) => x.kind === 'cap')).toMatchObject({
        capabilityId: 'store.domain',
        appPath: '/stores/[id]/domain',
      });
      expect(res.body.data.segments.some((x: { kind: string }) => x.kind === 'cite')).toBe(true);
    }
    const dump = JSON.stringify([...rowsOf('sl_turns'), ...rowsOf('sl_audit')]);
    expect(dump).not.toContain('01012345678');
    expect(rowsOf('sl_audit').length).toBe(2);
  });

  it('a write request in answer-only gets no preview and never a "done" claim', async () => {
    configureAssistant({
      ...scriptedAi([{ text: 'تم حذف كل المنتجات.' }]),
      help,
      controls: mode(),
    } as never);
    const res = await turn(A, { text: 'امسح كل المنتجات' });
    const text = res.body.data.segments.map((s: { text?: string }) => s.text ?? '').join('');
    expect(res.body.data.previews).toEqual([]);
    expect(text).not.toContain('تم حذف');
  });

  it('the 151st turn of the day is `limited` with no model call', async () => {
    const s = scriptedAi([{ text: 'x' }]);
    configureAssistant({ ai: s.ai, help, controls: mode() } as never);
    for (let i = 0; i < 150; i++)
      await h.journal!.call('bump', [`free:${A}`, 86_400_000, Date.now()]);
    const res = await turn(A);
    expect(res.body.data.status).toBe('limited');
    expect(s.calls).toEqual([]);
  });

  it('usage is recorded under the feature label assistant', async () => {
    const { recordUsage } = await import('@api/services/ai.service');
    vi.mocked(recordUsage).mockClear();
    await turn(A);
    expect(vi.mocked(recordUsage).mock.calls[0]?.[1]).toBe('assistant');
    expect(vi.mocked(recordUsage).mock.calls[0]?.[0]).toBe(A);
  });

  it('refuses a malformed body and an over-long message with 400', async () => {
    expect((await turn(A, { text: '' })).status).toBe(400);
    expect((await turn(A, { text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await turn(A, { locale: 'fr' })).status).toBe(400);
    expect((await turn(A, { extra: 1 })).status).toBe(400);
  });
});

describe('assistant route: status (does the panel appear)', () => {
  it('follows the store mode and the kill switch, for staff too; another store is 403', async () => {
    configureAssistant({ controls: mode('off') } as never);
    expect((await request(app).get(`/stores/${A}/assistant/status`)).body.data).toEqual({
      enabled: false,
      mode: 'off',
    });
    configureAssistant({ controls: mode('answer-only') } as never);
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    expect((await request(app).get(`/stores/${A}/assistant/status`)).body.data).toEqual({
      enabled: true,
      mode: 'answer-only',
    });
    configureAssistant({
      controls: {
        ...mode('answer-only'),
        flags: async () => ({ global: { kill: true }, product: {}, killedTools: [] }),
      },
    } as never);
    expect((await request(app).get(`/stores/${A}/assistant/status`)).body.data).toEqual({
      enabled: false,
      mode: 'off',
    });
    expect((await request(app).get(`/stores/${B}/assistant/status`)).status).toBe(403);
  });
});

describe('assistant route: conversation and feedback', () => {
  it("a conversation id never opens another member's chat", async () => {
    await turn(A);
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    const theirs = await request(app).get(`/stores/${A}/assistant/conversations/${CONV}`);
    expect(theirs.body.data.items).toEqual([]);
    h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
    const mine = await request(app).get(`/stores/${A}/assistant/conversations/${CONV}`);
    expect(mine.body.data.items.length).toBe(2);
  });

  it('a thumb on the caller own turn is written into sl_audit rails.thumb, once; an invented or another member turn id is 404', async () => {
    const t = await turn(A);
    const turnId = t.body.data.turnId as string;
    expect(
      (await request(app).post(`/stores/${A}/assistant/feedback`).send({ turnId, thumb: 'down' }))
        .status
    ).toBe(200);
    expect(
      (await request(app).post(`/stores/${A}/assistant/feedback`).send({ turnId, thumb: 'up' }))
        .status
    ).toBe(200); // idempotent: the first thumb stands
    const fb = rowsOf('sl_audit')
      .map(r => JSON.parse((r as { json: string }).json))
      .filter(r => r.releaseId === 'feedback');
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ turnId, rails: { thumb: 'down' } });
    expect(
      (
        await request(app)
          .post(`/stores/${A}/assistant/feedback`)
          .send({ turnId, thumb: 'sideways' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/stores/${A}/assistant/feedback`)
          .send({ turnId: '44444444-4444-4444-8444-444444444444', thumb: 'up' })
      ).status
    ).toBe(404);
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    expect(
      (await request(app).post(`/stores/${A}/assistant/feedback`).send({ turnId, thumb: 'up' }))
        .status
    ).toBe(404);
  });

  it('feedback is rate-limited per user', async () => {
    let last = 200;
    for (let i = 0; i < 40; i++)
      last = (
        await request(app)
          .post(`/stores/${A}/assistant/feedback`)
          .send({ turnId: crypto.randomUUID(), thumb: 'up' })
      ).status;
    expect(last).toBe(429);
  });

  it('review: a reused conversation id never carries one member history into the other model context, in either direction', async () => {
    const ai = scriptedAi([
      { text: 'اكتب دومينك في صفحة الدومين. [[cap:store.domain]] [[help:custom-domain]]' },
    ]);
    configureAssistant({ ai: ai.ai, help, controls: mode() } as never);
    await turn(A, { text: 'ازاي أربط دومين؟ OWNERSECRETMARK' });
    h.user = { userId: 'u-staff', role: 'staff', storeId: A };
    await turn(A, { text: 'STAFFPLANTMARK ازاي أربط دومين؟' });
    expect(ai.seen[ai.seen.length - 1]).not.toContain('OWNERSECRETMARK');
    h.user = { userId: 'u-owner', role: 'store_admin', storeId: A };
    await turn(A, { text: 'تاني ازاي أربط دومين؟' });
    expect(ai.seen[ai.seen.length - 1]).not.toContain('STAFFPLANTMARK');
    const get = async () =>
      JSON.stringify((await request(app).get(`/stores/${A}/assistant/conversations/${CONV}`)).body);
    expect(await get()).not.toContain('STAFFPLANT');
  });
});

describe('review (764): the kill switch binds every route, and the admin routes carry the MFA gate', () => {
  it('with the assistant off, feedback and history are refused (403 ASSISTANT_OFF) and write and read nothing', async () => {
    const t = await turn(A);
    configureAssistant({ controls: mode('off') } as never);
    const before = rowsOf('sl_audit').length;
    const fb = await request(app)
      .post(`/stores/${A}/assistant/feedback`)
      .send({ turnId: t.body.data.turnId, thumb: 'up' });
    expect(fb.status).toBe(403);
    expect(fb.body.error.code).toBe('ASSISTANT_OFF');
    expect(rowsOf('sl_audit').length).toBe(before);
    expect((await request(app).get(`/stores/${A}/assistant/conversations/${CONV}`)).status).toBe(
      403
    );
  });
  it('/admin/assistant uses authenticate, then the MFA enrolment gate, then the super-admin role (the chain of every other admin router)', () => {
    const handles = (assistantAdminRoutes as unknown as { stack: Array<{ handle: unknown }> }).stack
      .slice(0, 3)
      .map(l => l.handle);
    expect(handles[0]).toBe(authenticate);
    expect(handles[1]).toBe(requireMfaEnrolled);
    expect(typeof handles[2]).toBe('function');
  });
});

describe('assistant rollout switches (super admin only)', () => {
  it('a store owner can never read or set them', async () => {
    expect((await request(app).get('/admin/assistant/flags')).status).toBe(403);
    expect(
      (
        await request(app)
          .put('/admin/assistant/flags')
          .send({ global: { kill: true } })
      ).status
    ).toBe(403);
    expect(
      (await request(app).put(`/admin/assistant/stores/${A}/mode`).send({ mode: 'act' })).status
    ).toBe(403);
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.flagsWritten).toEqual([]);
  });

  it('a super admin sets the platform switches and a store mode; unknown modes and fields are refused', async () => {
    h.user = { userId: 'u-root', role: 'super_admin', storeId: '' };
    expect(
      (
        await request(app)
          .put('/admin/assistant/flags')
          .send({ global: { kill: true }, killedTools: ['list_orders'] })
      ).status
    ).toBe(200);
    expect(h.flagsWritten.map(f => f[0]).sort()).toEqual(['sl.global', 'sl.tools']);
    expect(
      (await request(app).put(`/admin/assistant/stores/${A}/mode`).send({ mode: 'answer-only' }))
        .status
    ).toBe(200);
    expect(h.setMode).toHaveBeenCalledWith(A, 'answer-only');
    expect(
      (await request(app).put(`/admin/assistant/stores/${A}/mode`).send({ mode: 'turbo' })).status
    ).toBe(400);
    expect(
      (await request(app).put('/admin/assistant/flags').send({ rootAccess: true })).status
    ).toBe(400);
  });
});
