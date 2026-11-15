/** Smart Layer Phase A, the Store adapter (plan 4 A15): contract with the registry, tool scoping and RBAC, help index, switches, quota. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGET,
  checkAdapterContract,
  type RefCheck,
  type TurnCtx,
} from '@ebda/shared/smart-layer';

vi.mock('@api/lib/repo-factory', () => ({ storeDb: vi.fn(), storeSmartLayer: vi.fn() }));
vi.mock('@api/services/plan.service', () => ({
  planService: { listPlans: vi.fn(async () => []) },
}));
vi.mock('@api/services/setup-guide.service', () => ({
  SetupGuideService: { get: vi.fn(async () => ({ done: 2 })) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => true) }));
vi.mock('@api/services/ai.service', () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn(async () => undefined) }));
vi.mock('@api/lib/store-ai-switch', () => ({ isStoreAiEnabled: vi.fn(async () => true) }));
vi.mock('@api/lib/search/embedding-provider', () => ({ getEmbeddingProvider: () => null }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
const mcp = vi.hoisted(() => ({ analytics: vi.fn(async () => ({ orders: 3 })) }));
vi.mock('@api/services/analytics.service', () => ({
  AnalyticsService: {
    getDashboardStats: (...a: unknown[]) => mcp.analytics(...a),
    getTopProducts: async () => [],
    getLowStockProducts: async () => [],
  },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));

import { storeAdapter, ASSISTANT_CAPABILITY } from '@api/smart-layer/adapter';
import { ReadForbidden, callMerchantRead, READ_PERMISSIONS } from '@api/smart-layer/merchant-read';
import {
  ensureHelpIndex,
  helpFigureSources,
  helpSearch,
  HASH_KEY,
  IDS_KEY,
  type HelpCorpus,
  type HelpDeps,
} from '@api/smart-layer/help-index';
import { FLAG, readPlatformFlags, storeControls } from '@api/smart-layer/controls';
import { storeQuota } from '@api/smart-layer/quota';
import { storeRegistry } from '@api/smart-layer/registry';
import { helpCorpus } from '@api/smart-layer/help-index';
import { nodeJournal } from '../helpers/smart-layer-node-sql';
import { doStorage } from '@api/smart-layer/storage-do';

const S = '11111111-1111-4111-8111-111111111111';
const ctx = (over: Partial<TurnCtx> = {}): TurnCtx => ({
  product: 'store',
  storeId: S,
  userId: 'u1',
  role: 'store_admin',
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
  ...over,
});
const noHelp: HelpDeps = { kv: undefined, vectors: undefined, embed: undefined };
const adapter = (
  over: Parameters<typeof storeAdapter>[0] extends infer P ? Partial<P> : never = {}
) => storeAdapter({ storeId: S, help: noHelp, ai: { run: async () => ({}) }, ...over });

describe('adapter contract', () => {
  it('the tool list agrees with the capability registry (no weaker policy, every capability live, no forbidden tool)', () => {
    expect(checkAdapterContract(adapter())).toEqual([]);
  });
  it('every read tool is free, and every tool (read or write) sits on a live capability', () => {
    const a = adapter();
    expect(a.tools().filter(t => !t.preview && t.policy !== 'free')).toEqual([]);
    for (const t of a.tools())
      expect(a.registry().caps.get(t.capabilityId)?.status, t.name).toBe('live');
  });
  it('no tool lets the model name a store, a workspace, a path or a url (store scoping cannot be argued with)', () => {
    for (const t of adapter().tools()) {
      const props = Object.keys(
        (t.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      expect(
        // A write tool may carry merchant CONTENT such as a link the merchant wants shown (googleMapsUrl); it may never name which store to act on.
        props.filter(p =>
          (t.preview ? /^(store|workspace)(id)?$|path/i : /store|workspace|path|url/i).test(p)
        ),
        t.name
      ).toEqual([]);
    }
  });
  it('every id a tool takes is declared as a ref, so the adapter checks it exists in THIS store first', () => {
    const t = adapter().tools();
    expect(t.find(x => x.name === 'get_product')!.refs!({ productId: 'p1' })).toEqual([
      { kind: 'product', id: 'p1' },
    ]);
    expect(t.find(x => x.name === 'get_order')!.refs!({ orderId: 'o1' })).toEqual([
      { kind: 'order', id: 'o1' },
    ]);
    expect(t.find(x => x.name === 'get_customer')!.refs!({ customerId: 'c1' })).toEqual([
      { kind: 'customer', id: 'c1' },
    ]);
  });
  it('customer-written text (orders, customers) is untrusted; plans and help are typed sources', () => {
    const t = adapter().tools();
    for (const n of ['list_orders', 'get_order', 'list_customers', 'get_customer'])
      expect(t.find(x => x.name === n)!.resultTrust, n).toBe('untrusted');
    expect(t.find(x => x.name === 'quote_plan')!.resultTrust).toBe('typed-source');
  });
  it('checkRefs: an id of another store is missing, an unknown kind fails closed, a thrown lookup is missing', async () => {
    const a = adapter({ checkRef: async (_s, r) => r.id === 'mine' });
    const refs: RefCheck[] = [
      { kind: 'product', id: 'mine' },
      { kind: 'product', id: 'theirs' },
    ];
    expect((await a.checkRefs(ctx(), refs)).missing).toEqual([refs[1]]);
    expect((await adapter().checkRefs(ctx(), [{ kind: 'webhook', id: 'x' }])).missing).toEqual([
      { kind: 'webhook', id: 'x' },
    ]); // the default check: an unknown kind fails closed
    const boom = adapter({
      checkRef: async () => {
        throw new Error('db');
      },
    });
    expect((await boom.checkRefs(ctx(), [refs[0]!])).missing).toEqual([refs[0]]);
  });
  it('binding sources carry the plans, the free cap and the figures the guides state', async () => {
    const s = await adapter({
      tools: {
        plans: async () => [
          {
            code: 'growth',
            nameEn: 'Growth',
            nameAr: 'نمو',
            priceMonthlyMinor: 49900,
            priceYearlyMinor: null,
            limits: {},
          },
        ],
      },
    }).bindingSources(ctx());
    expect(s.find(x => x.key === 'growth')!.values).toEqual(['نمو', 'Growth', '499']);
    expect(s.find(x => x.key === 'assistant-free-turns')!.values).toEqual([
      String(BUDGET.freeTurnsPerStorePerDay),
    ]);
    expect(s.some(x => x.key.startsWith('help:'))).toBe(true);
  });
});

describe('tools: role-based reads (act as the merchant)', () => {
  it('quote_plan and get_store_setup need the owner permission: staff gets a refusal, the owner an answer', async () => {
    const a = adapter({
      tools: {
        plans: async () => [
          {
            code: 'g',
            nameEn: 'G',
            nameAr: 'ج',
            priceMonthlyMinor: 1000,
            priceYearlyMinor: 2000,
            limits: {},
          },
        ],
      },
    });
    const tool = (n: string) => a.tools().find(x => x.name === n)!;
    await expect(tool('quote_plan').read!(ctx({ role: 'staff' }), {})).rejects.toBeInstanceOf(
      ReadForbidden
    );
    await expect(tool('get_store_setup').read!(ctx({ role: 'staff' }), {})).rejects.toBeInstanceOf(
      ReadForbidden
    );
    expect(await tool('quote_plan').read!(ctx(), {})).toEqual([
      expect.objectContaining({ code: 'g', monthlyEgp: '10', yearlyEgp: '20' }),
    ]);
    expect(await tool('get_store_setup').read!(ctx(), {})).toEqual({ done: 2 });
  });
  it('MCP-backed reads go through the Merchant MCP handlers, are read-only and role-gated', async () => {
    const store = { id: S, name: 'n', slug: 's', currency: 'EGP', domain: null };
    await expect(
      callMerchantRead(
        { storeId: S, userId: 'u', role: 'staff' },
        'admin_get_funnel',
        {},
        { store }
      )
    ).rejects.toBeInstanceOf(ReadForbidden); // owner-only screen
    await expect(
      callMerchantRead(
        { storeId: S, userId: 'u', role: 'customer' },
        'admin_list_orders',
        {},
        { store }
      )
    ).rejects.toBeInstanceOf(ReadForbidden); // a shopper never
    await expect(
      callMerchantRead(
        { storeId: S, userId: 'u', role: 'store_admin' },
        'admin_delete_product' as never,
        {},
        { store }
      )
    ).rejects.toBeInstanceOf(ReadForbidden); // a write tool name cannot be called
    await expect(
      callMerchantRead(
        { storeId: 'other', userId: 'u', role: 'store_admin' },
        'admin_get_analytics',
        {},
        { store }
      )
    ).rejects.toBeInstanceOf(ReadForbidden); // never a store other than the turn's
    const out = (await callMerchantRead(
      { storeId: S, userId: 'u', role: 'staff' },
      'admin_get_analytics',
      {},
      { store }
    )) as { stats: { orders: number } };
    expect(out.stats.orders).toBe(3);
    expect(mcp.analytics).toHaveBeenCalledWith(S, undefined); // the store of the TURN, not anything the model said
  });
  it('every allow-listed read is a read permission, never a write one', () => {
    for (const p of Object.values(READ_PERMISSIONS)) expect(p).toMatch(/:(read|settings)$/);
  });
});

describe('controls', () => {
  const flags =
    (g: unknown = { mode: 'act' }, p: unknown = {}, t: string[] = []) =>
    async () =>
      ({ global: g, product: p, killedTools: t }) as Awaited<ReturnType<typeof readPlatformFlags>>;
  const base = { flags: flags(), mode: async () => 'answer-only' as const, aiOn: async () => true };
  it('a store is off until a super admin sets it; the platform switches win; the merchant AI switch turns it off too', async () => {
    expect((await storeControls(S, { ...base, mode: async () => 'off' })).mode).toBe('off');
    expect((await storeControls(S, base)).mode).toBe('answer-only');
    expect(
      (
        await storeControls(S, {
          ...base,
          mode: async () => 'act',
          flags: flags({ mode: 'answer-only' }),
        })
      ).mode
    ).toBe('answer-only');
    expect(await storeControls(S, { ...base, flags: flags({ kill: true }) })).toMatchObject({
      mode: 'off',
      killGlobal: true,
    });
    expect(await storeControls(S, { ...base, flags: flags({}, { kill: true }) })).toMatchObject({
      mode: 'off',
      killProduct: true,
    });
    expect(
      (await storeControls(S, { ...base, flags: flags({}, {}, ['list_orders']) })).killedTools.has(
        'list_orders'
      )
    ).toBe(true);
    expect((await storeControls(S, { ...base, aiOn: async () => false })).mode).toBe('off');
  });
  it('an UNSET platform cap is the most restrictive one: a store flagged act stays off until a super admin sets a cap (probe from the review)', async () => {
    const c = await storeControls(S, { ...base, mode: async () => 'act', flags: flags({}) });
    expect(c.mode).toBe('off');
    expect(
      (
        await storeControls(S, {
          ...base,
          mode: async () => 'act',
          flags: flags({ mode: 'answer-only' }),
        })
      ).mode
    ).toBe('answer-only');
  });
  it('an unreadable switch fails closed', async () => {
    expect(
      await storeControls(S, {
        ...base,
        flags: async () => {
          throw new Error('d1 down');
        },
      })
    ).toMatchObject({ mode: 'off', killGlobal: true });
  });
  it('reads D1 system_settings by the three keys and parses their JSON', async () => {
    const rows = [
      { key: FLAG.global, value: '{"kill":true}' },
      { key: FLAG.tools, value: '["a"]' },
      { key: FLAG.product, value: 'not json' },
    ];
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
          first: async () => null,
          run: async () => ({}),
        }),
      }),
    };
    expect(await readPlatformFlags(db as never)).toEqual({
      global: { kill: true },
      product: { kill: true }, // present but unparseable: fail closed
      killedTools: ['a'],
    });
    await expect(readPlatformFlags(undefined)).rejects.toThrow();
  });
});

describe('review fixes', () => {
  it('a malformed kill switch fails closed (global and product); a malformed tools list kills nothing', async () => {
    const rows = [
      { key: FLAG.global, value: '{kill:true' },
      { key: FLAG.product, value: 'nope' },
      { key: FLAG.tools, value: '{' },
    ];
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
          first: async () => null,
          run: async () => ({}),
        }),
      }),
    };
    expect(await readPlatformFlags(db as never)).toEqual({
      global: { kill: true },
      product: { kill: true },
      killedTools: [],
    });
  });
  it('a handoff never carries transcript text (ids and sizes only)', async () => {
    const { storeHandoff } = await import('@api/smart-layer/handoff');
    const send = vi.fn(async () => true);
    await storeHandoff(send as never)(ctx(), {
      reason: 'asked_human',
      maskedTranscript: 'merchant: العميلة منى السيد عايزة ترجع',
      journalIds: ['t1'],
    });
    const sent = JSON.stringify(send.mock.calls[0]);
    expect(sent).not.toContain('منى');
    expect(sent).toContain('t1');
  });
  it('eraseMentions removes only the rows naming the term, from turns and audit', () => {
    const j = nodeJournal();
    const ins = (id: string, text: string) =>
      j.db.run(
        'INSERT INTO sl_turns (id, store_id, thread_id, user_id, role, masked_text, at, release_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, S, 'c', 'u', 'assistant', text, 1, 'r']
      );
    ins('a', 'لقيت منى السيد');
    ins('b', 'مبيعات اليوم');
    j.db.run('INSERT INTO sl_audit (id, store_id, user_id, at, json) VALUES (?, ?, ?, ?, ?)', [
      'x',
      S,
      'u',
      1,
      '{"maskedPrompt":"منى السيد"}',
    ]);
    j.db.run('INSERT INTO sl_audit (id, store_id, user_id, at, json) VALUES (?, ?, ?, ?, ?)', [
      'y',
      S,
      'u',
      1,
      '{"maskedPrompt":"رصيد"}',
    ]);
    return j.call('eraseMentions', [['منى السيد', 'ab']]).then(() => {
      expect(j.db.all('SELECT id FROM sl_turns', [])).toEqual([{ id: 'b' }]);
      expect(j.db.all('SELECT id FROM sl_audit', [])).toEqual([{ id: 'y' }]);
    });
  });
});

describe('review (764) minors', () => {
  it('merchantDomains: the custom domain counts only once it is verified', async () => {
    const { storeDb } = await import('@api/lib/repo-factory');
    const row = (status: string) => ({
      store: {
        findUnique: async () => ({ slug: 'shop', domain: 'shop.example', domainStatus: status }),
      },
    });
    vi.mocked(storeDb).mockResolvedValueOnce(row('pending') as never);
    expect(await adapter().merchantDomains(ctx())).toEqual(['shop.ebda.app']);
    vi.mocked(storeDb).mockResolvedValueOnce(row('active') as never);
    expect(await adapter().merchantDomains(ctx())).toEqual(['shop.ebda.app', 'shop.example']);
  });
  it('the weekly digest reads at most 500 stores, 10 at a time, and cuts each question to 80 characters', async () => {
    const { weeklyUnanswered } = await import('@api/smart-layer/weekly-report');
    let live = 0;
    let peak = 0;
    let loaded = 0;
    const load = async () => {
      loaded++;
      live++;
      peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 1));
      live--;
      return [
        {
          id: 'x',
          storeId: 's',
          userId: 'u',
          turnId: 't',
          at: 1,
          releaseId: 'r',
          maskedPrompt: 'ق'.repeat(200),
          maskedOutput: '',
          rails: {},
          toolsOffered: [],
          toolCalls: [],
          outcome: 'not_covered',
          inputTokens: 0,
          outputTokens: 0,
          model: 'm',
        },
      ] as never;
    };
    const sent: string[] = [];
    const monday = Date.UTC(2026, 10, 16, 6);
    await weeklyUnanswered({
      now: monday,
      stores: async () => Array.from({ length: 800 }, (_, i) => `s${i}`),
      load,
      kv: { get: async () => null, put: async () => undefined },
      send: async t => void sent.push(t),
    });
    expect(loaded).toBe(500);
    expect(peak).toBeLessThanOrEqual(10);
    expect(sent[0]!.split('\n')[0]!.length).toBeLessThanOrEqual(86);
  });
});

describe('quota', () => {
  it('the 151st turn is refused, another store is unaffected, and a missing platform headroom refuses before the counter', async () => {
    const j = nodeJournal();
    const st = doStorage(j.call);
    const assert = vi.fn(async () => undefined);
    const q = storeQuota(st, { assert, record: vi.fn(async () => undefined) });
    for (let i = 0; i < 150; i++) await q.assertTurn(ctx({ now: 1_800_000_000_000 + i }));
    await expect(q.assertTurn(ctx({ now: 1_800_000_001_000 }))).rejects.toThrow('free_cap');
    await expect(q.assertTurn(ctx({ storeId: 'other-store' }))).resolves.toBeUndefined();
    const refuse = storeQuota(st, {
      assert: async () => {
        throw new Error('over platform cap');
      },
    });
    await expect(refuse.assertTurn(ctx({ storeId: 'third' }))).rejects.toThrow('over platform cap');
    expect(await j.call('bump', [`free:third`, 86_400_000, 1])).toBe(1); // the refused turn did not count
  });
  it('heavy jobs are not available in Phase A; usage is recorded as feature assistant with the model', async () => {
    const record = vi.fn(async () => undefined);
    const q = storeQuota(doStorage(nodeJournal().call), {
      assert: vi.fn(async () => undefined),
      record,
    });
    await expect(q.assertTurn(ctx(), 5)).rejects.toThrow('heavy_not_available');
    await q.record(ctx(), { inputTokens: 3, outputTokens: 4, model: 'm1' });
    expect(record).toHaveBeenCalledWith(S, 'assistant', 3, 4, false, { model: 'm1' });
  });
});

describe('help index', () => {
  const fake = () => {
    const kv = new Map<string, string>();
    const upserts: Array<{ id: string; namespace: string }> = [];
    const deleted: string[] = [];
    const embedded: string[] = [];
    const deps: HelpDeps = {
      kv: { get: async k => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      embed: async t => {
        embedded.push(...t);
        return t.map(() => [0.1]);
      },
      vectors: {
        upsert: async v => {
          upserts.push(...v);
          return {};
        },
        deleteByIds: async ids => {
          deleted.push(...ids);
          return {};
        },
        query: async () => ({
          matches: [
            {
              id: 'a',
              score: 0.8,
              metadata: {
                articleId: 'x',
                locale: 'en',
                title: 'X',
                url: 'https://help.ebda.app/x/',
                appPath: '',
                text: 'english',
              },
            },
            {
              id: 'b',
              score: 0.7,
              metadata: {
                articleId: 'x',
                locale: 'ar',
                title: 'س',
                url: 'https://help.ebda.app/x/',
                appPath: '/stores',
                text: 'عربي',
              },
            },
          ],
        }),
      },
    };
    return { deps, upserts, deleted, embedded, kv };
  };
  const tiny: HelpCorpus = {
    hash: 'h1',
    docs: [
      {
        articleId: 'a',
        locale: 'ar',
        title: 'أ',
        url: 'u',
        appPath: null,
        capabilityIds: [],
        chunks: ['one', 'two'],
      },
    ],
  };
  it('indexes once per corpus hash, skips when unchanged, re-indexes on change and deletes vectors of chunks that went away', async () => {
    const f = fake();
    expect(await ensureHelpIndex(f.deps, tiny)).toBe('indexed');
    expect(f.upserts.map(u => u.namespace)).toEqual(['__help__', '__help__']);
    expect(await ensureHelpIndex(f.deps, tiny)).toBe('skipped');
    expect(f.upserts.length).toBe(2);
    expect(
      await ensureHelpIndex(f.deps, { hash: 'h2', docs: [{ ...tiny.docs[0]!, chunks: ['one'] }] })
    ).toBe('indexed');
    expect(f.deleted.length).toBe(1);
    expect(f.kv.get(HASH_KEY)).toBe('h2');
    expect(JSON.parse(f.kv.get(IDS_KEY)!).length).toBe(1);
  });
  it('is unavailable (no throw) without an index, a model or KV', async () => {
    expect(await ensureHelpIndex(noHelp, tiny)).toBe('unavailable');
    expect(await helpSearch(noHelp, 'q', 'ar', 3)).toEqual([]);
  });
  it('search embeds the MASKED question and returns only hits of the asked language', async () => {
    const f = fake();
    const hits = await helpSearch(f.deps, 'اتصل بيا على 01012345678', 'ar', 3);
    expect(f.embedded.join(' ')).not.toContain('01012345678');
    expect(hits.map(h => h.text)).toEqual(['عربي']);
    expect(hits[0]).toMatchObject({ articleId: 'x', appPath: '/stores' });
  });
  it('the bundled corpus covers Arabic and English, includes the Store guides and the new assistant guide, and states the 72-hour domain figure', () => {
    const c = helpCorpus();
    expect(new Set(c.docs.map(d => d.locale))).toEqual(new Set(['ar', 'en']));
    expect(
      c.docs.some(
        d => d.articleId === 'ebda-assistant' && d.capabilityIds.includes('ai.merchant-assistant')
      )
    ).toBe(true);
    expect(helpFigureSources(c).some(s => s.values.includes('72'))).toBe(true);
  });
});

describe('bundled assets', () => {
  it('registry.generated.json and help-corpus.generated.json are current (run node apps/api/scripts/build-help-corpus.mjs)', async () => {
    // @ts-expect-error plain .mjs script
    const { buildAssets } = (await import('../../apps/api/scripts/build-help-corpus.mjs')) as {
      buildAssets(): Promise<{ registry: string; corpus: string }>;
    };
    const { registry, corpus } = await buildAssets();
    const dir = join(__dirname, '../../apps/api/src/smart-layer');
    expect(readFileSync(join(dir, 'registry.generated.json'), 'utf8') === registry).toBe(true);
    expect(readFileSync(join(dir, 'help-corpus.generated.json'), 'utf8') === corpus).toBe(true);
  });
  it('the assistant capability and the tools agree on the id the registry carries', () => {
    expect(storeRegistry().caps.get(ASSISTANT_CAPABILITY)?.status).toBe('live');
  });
});
