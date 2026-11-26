/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doCreate } from './do-read';

// Ported from tests/integration/answer-engine/dashboard.test.ts and gsc-dashboard.test.ts (Postgres, a running API at localhost:4000) to the
// built Worker + StoreDO, over HTTP: GET /stores/:id/answer-engine/summary (per-engine aggregates, the grounded caveat, groundingUnavailable,
// the per-prompt win/lose list, a trend) and GET /stores/:id/answer-engine/gsc (trend ascending by date, impression-weighted totals, top queries from the
// LATEST row only, hasData:false / connected:false for a store with no rows). Tenant isolation, both ways: each store's response never contains the
// other's rows, and a store_admin who owns store B gets 403 (never data) on store A. A store with answer_engine_insights turned off gets 403
// FEATURE_DISABLED. Rows are seeded straight into the StoreDO (the cron writes them; no route does).
const e = env as unknown as {
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
};
const RUN = crypto.randomUUID().slice(0, 8);
let A: Merchant;
let B: Merchant;
let empty: Merchant;
let noFeature: Merchant;
const STORE_B_UNIQUE_PROMPT = `store-b-unique-prompt-${RUN}`;
const STORE_B_UNIQUE_QUERY = `store-b-unique-query-${RUN}`;
const domainOf = (m: Merchant) => `${m.slug}.example.com`;
const utc = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`).getTime();
const summary = (m: Merchant, token = m.token) =>
  call(`/stores/${m.storeId}/answer-engine/summary`, { token });
const gsc = (m: Merchant, token = m.token) =>
  call(`/stores/${m.storeId}/answer-engine/gsc`, { token });
const check = (m: Merchant, row: Record<string, unknown>) =>
  doCreate(m.storeId, 'AnswerEngineCheck', {
    storeId: m.storeId,
    locale: 'en',
    cited: false,
    citedUrls: [],
    competitorUrls: [],
    runAt: new Date(),
    ...row,
  });
const metric = (
  m: Merchant,
  date: string,
  impressions: number,
  clicks: number,
  ctr: number,
  position: number,
  topQueries: unknown[]
) =>
  doCreate(m.storeId, 'GscDailyMetric', {
    storeId: m.storeId,
    date: new Date(utc(date)),
    impressions,
    clicks,
    ctr,
    position,
    topQueries,
  });

describe('answer-engine dashboards on the Worker', () => {
  beforeAll(async () => {
    A = await bootstrapMerchant('aed-a');
    B = await bootstrapMerchant('aed-b');
    empty = await bootstrapMerchant('aed-empty');
    noFeature = await bootstrapMerchant('aed-nofeature');
    // the override (not the plan) is what gates it: the plan baseline has the feature on
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 0, ?4)'
    )
      .bind(`aed-off-${noFeature.storeId}`, noFeature.storeId, 'answer_engine_insights', Date.now())
      .run();

    // gemini: one cited, one not (competitor): groundedCaveat false
    await check(A, {
      engine: 'gemini',
      promptText: 'best gadgets in Egypt',
      cited: true,
      rank: 1,
      snippet: 'Great gadgets at this store.',
      citedUrls: [`https://${domainOf(A)}/best-gadgets`],
    });
    await check(A, {
      engine: 'gemini',
      promptText: 'where to buy smart widget in Egypt',
      competitorUrls: ['https://competitor-a1.example'],
    });
    await check(A, {
      engine: 'perplexity',
      promptText: 'best gadgets in Egypt',
      cited: true,
      rank: 2,
      snippet: 'Also available at this store.',
      citedUrls: [`https://${domainOf(A)}/gadgets`],
    });
    await check(A, {
      engine: 'perplexity',
      promptText: 'where to buy smart widget in Egypt',
      competitorUrls: ['https://competitor-a2.example'],
    });
    // openai: the ONLY check has empty citedUrls -> groundedCaveat true
    await check(A, {
      engine: 'openai',
      promptText: 'best gadgets in Egypt',
      competitorUrls: ['https://competitor-a3.example'],
    });
    // store B: a distinct prompt and domain that must never leak into A's summary
    await check(B, {
      engine: 'gemini',
      promptText: STORE_B_UNIQUE_PROMPT,
      cited: true,
      citedUrls: [`https://${domainOf(B)}/z`],
    });

    await metric(A, '2026-07-18', 100, 10, 0.1, 8, [
      { query: 'old query', impressions: 50, clicks: 2 },
    ]);
    await metric(A, '2026-07-19', 200, 20, 0.1, 6, [
      { query: 'mid query', impressions: 80, clicks: 6 },
    ]);
    await metric(A, '2026-07-20', 300, 45, 0.15, 4, [
      { query: 'best gadgets cairo', impressions: 120, clicks: 20 },
      { query: 'smart widget store', impressions: 60, clicks: 5 },
    ]);
    await metric(B, '2026-07-20', 999, 99, 0.099, 2, [
      { query: STORE_B_UNIQUE_QUERY, impressions: 999, clicks: 99 },
    ]);
  }, 180_000);

  describe('GET /stores/:storeId/answer-engine/summary', () => {
    it("returns Store A's correct per-engine aggregates, grounded caveat, and per-prompt win/lose list", async () => {
      const res = await summary(A);
      expect(res.status, res.text).toBe(200);
      expect(res.json.success).toBe(true);
      const { engines, trend, prompts, lastRunAt } = res.json.data;
      const byEngine = Object.fromEntries(engines.map((x: any) => [x.engine, x]));
      expect(byEngine.gemini).toMatchObject({
        totalChecks: 2,
        citedCount: 1,
        groundedCaveat: false,
      });
      expect(byEngine.gemini.citedRate).toBeCloseTo(0.5);
      expect(byEngine.perplexity).toMatchObject({
        totalChecks: 2,
        citedCount: 1,
        groundedCaveat: false,
      });
      expect(byEngine.openai).toMatchObject({
        totalChecks: 1,
        citedCount: 0,
        groundedCaveat: true,
      });
      expect(prompts.length).toBe(5);
      const win = prompts.find(
        (p: any) => p.engine === 'gemini' && p.promptText === 'best gadgets in Egypt'
      );
      expect(win.cited).toBe(true);
      expect(win.competitorUrls).toEqual([]);
      const loss = prompts.find(
        (p: any) => p.engine === 'gemini' && p.promptText === 'where to buy smart widget in Egypt'
      );
      expect(loss.cited).toBe(false);
      expect(loss.competitorUrls).toEqual(['https://competitor-a1.example']);
      expect(trend.length).toBeGreaterThanOrEqual(1);
      expect(trend.reduce((s: number, t: any) => s + t.totalChecks, 0)).toBe(5);
      expect(trend.reduce((s: number, t: any) => s + t.citedCount, 0)).toBe(2);
      expect(lastRunAt).not.toBeNull();
      // TENANT ISOLATION: store B's rows never reach store A's summary
      expect(prompts.some((p: any) => p.promptText === STORE_B_UNIQUE_PROMPT)).toBe(false);
      expect(res.text).not.toContain(STORE_B_UNIQUE_PROMPT);
      expect(res.text).not.toContain(domainOf(B));
    });

    it("Store B's own summary contains only its own row, never Store A's data", async () => {
      const res = await summary(B);
      expect(res.status, res.text).toBe(200);
      expect(res.json.data.prompts.length).toBe(1);
      expect(res.json.data.prompts[0].promptText).toBe(STORE_B_UNIQUE_PROMPT);
      expect(res.text).not.toContain('best gadgets in Egypt');
      expect(res.text).not.toContain(domainOf(A));
    });

    it('a store_admin who owns Store B gets 403 (not data) when requesting Store A summary directly', async () => {
      const res = await summary(A, B.token);
      expect(res.status).toBe(403);
      expect(res.json.success).not.toBe(true);
    });

    it('a store with answer_engine_insights disabled gets 403 FEATURE_DISABLED, never data', async () => {
      const res = await summary(noFeature);
      expect(res.status, res.text).toBe(403);
      expect(res.json.error?.code ?? res.json.code).toBe('FEATURE_DISABLED');
      expect(res.json.data).toBeUndefined();
    });

    it('an engine whose latest check recorded a groundingUnavailableReason reports groundingUnavailable: true (issue #929)', async () => {
      await check(empty, {
        engine: 'gemini',
        promptText: 'best gadgets in Egypt',
        groundingUnavailableReason: 'http_429',
      });
      const res = await summary(empty);
      expect(res.status, res.text).toBe(200);
      const byEngine = Object.fromEntries(res.json.data.engines.map((x: any) => [x.engine, x]));
      expect(byEngine.gemini).toMatchObject({ groundedCaveat: true, groundingUnavailable: true });
    });
  });

  describe('GET /stores/:storeId/answer-engine/gsc', () => {
    it("returns Store A's trend, totals, and top queries from the latest row", async () => {
      const res = await gsc(A);
      expect(res.status, res.text).toBe(200);
      expect(res.json.success).toBe(true);
      const { connected, hasData, trend, totals, topQueries, lastUpdatedAt } = res.json.data;
      expect(connected).toBe(true);
      expect(hasData).toBe(true);
      expect(trend.map((t: any) => t.date)).toEqual(['2026-07-18', '2026-07-19', '2026-07-20']);
      expect(trend[2]).toMatchObject({ impressions: 300, clicks: 45, position: 4 });
      expect(totals.impressions).toBe(600);
      expect(totals.clicks).toBe(75);
      expect(totals.ctr).toBeCloseTo(75 / 600);
      // impression-weighted avg position
      expect(totals.avgPosition).toBeCloseTo((8 * 100 + 6 * 200 + 4 * 300) / 600);
      expect(topQueries.map((q: any) => q.query)).toEqual([
        'best gadgets cairo',
        'smart widget store',
      ]); // the LATEST row only
      expect(lastUpdatedAt).not.toBeNull();
      expect(res.text).not.toContain(STORE_B_UNIQUE_QUERY);
      expect(res.text).not.toContain(domainOf(B));
      expect(totals.impressions).not.toBe(600 + 999);
    });

    it("Store B's own response contains only its own row, never Store A's data", async () => {
      const res = await gsc(B);
      expect(res.status, res.text).toBe(200);
      expect(res.json.data.hasData).toBe(true);
      expect(res.json.data.trend.length).toBe(1);
      expect(res.json.data.topQueries).toEqual([
        { query: STORE_B_UNIQUE_QUERY, impressions: 999, clicks: 99 },
      ]);
      expect(res.text).not.toContain('best gadgets cairo');
      expect(res.text).not.toContain(domainOf(A));
    });

    it('a store_admin who owns Store B gets 403 (not data) when requesting Store A gsc directly', async () => {
      const res = await gsc(A, B.token);
      expect(res.status).toBe(403);
      expect(res.json.success).not.toBe(true);
    });

    it('a store with ZERO GscDailyMetric rows returns hasData:false / connected:false (not an error, not a fake zero chart)', async () => {
      const res = await gsc(empty);
      expect(res.status, res.text).toBe(200);
      expect(res.json.data).toMatchObject({
        connected: false,
        hasData: false,
        trend: [],
        totals: null,
        topQueries: [],
        lastUpdatedAt: null,
      });
    });

    it('a store with answer_engine_insights disabled gets 403 FEATURE_DISABLED, never data', async () => {
      const res = await gsc(noFeature);
      expect(res.status, res.text).toBe(403);
      expect(res.json.error?.code ?? res.json.code).toBe('FEATURE_DISABLED');
      expect(res.json.data).toBeUndefined();
    });
  });
});
