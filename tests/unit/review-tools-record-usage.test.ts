/**
 * Money review 2026-11-16: the four review AI calls (translate, spam check on EVERY customer review, product summary,
 * owner-response draft) called Gemini but never wrote an `ai_usage` row, so they did not count toward the store's
 * daily slice (`assertAiQuota` counts those rows) or the platform caps. Each now records usage (feature `reviews`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ usage: [] as Array<[string, string, number, number]> }));
const STORE = '11111111-1111-4111-8111-111111111111';
const REVIEW = {
  id: 'r1',
  storeId: STORE,
  body: 'Great mug',
  title: 'ok',
  rating: 5,
  language: 'en',
};

vi.mock('@api/config', async importOriginal => {
  const real = await importOriginal<typeof import('@api/config')>();
  return { ...real, config: { ...real.config, googleAiKey: 'test-key' } };
});
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: async () => undefined }));
vi.mock('@api/services/ai.service', () => ({
  recordUsage: async (storeId: string, feature: string, i: number, o: number) => {
    h.usage.push([storeId, feature, i, o]);
  },
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  currentStoreId: () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeDb: async () => ({
    review: {
      findUnique: async () => ({ ...REVIEW }),
      findFirst: async () => ({ ...REVIEW, product: { name: 'Mug', nameAr: null } }),
      findMany: async () => [{ storeId: STORE, rating: 5, body: 'Great mug', language: 'en' }],
    },
    store: { findUnique: async () => ({ name: 'Shop', nameAr: null }) },
  }),
  storeWriter: async () => ({ review: { update: async () => ({}) } }),
}));
vi.mock('@api/lib/ai/gemini-keys', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/ai/gemini-keys')>()),
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return {
        generateContent: async () => ({
          response: {
            text: () =>
              '{"translated":"x","spamScore":0.1,"reasons":[],"topPositives":[],"topNegatives":[],"overallSentiment":"positive","responseEn":"t","responseAr":"t"}',
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
          },
        }),
      };
    }
  },
}));

import {
  translateReview,
  detectSpamReview,
  summarizeProductReviews,
  draftOwnerResponse,
} from '../../apps/api/src/lib/ai/review-tools';

beforeEach(() => {
  h.usage = [];
  process.env.AI_BULK_THROTTLE_MS = '0';
});

describe('every review AI call records its usage row (feature "reviews")', () => {
  it.each([
    ['translateReview', () => translateReview('r1')],
    ['detectSpamReview', () => detectSpamReview('r1')],
    ['summarizeProductReviews', () => summarizeProductReviews(STORE, 'p1')],
    ['draftOwnerResponse', () => draftOwnerResponse(STORE, 'r1')],
  ])('%s', async (_name, call) => {
    await call();
    expect(h.usage).toEqual([[STORE, 'reviews', 11, 7]]);
  });
});

describe('fix-the-class: every file that calls a paid model also writes its usage rows (comments stripped)', () => {
  it('no file makes more model calls than usage-recording calls, outside the infra allowlist', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative, sep } = await import('node:path');
    const SRC = join(__dirname, '..', '..', 'apps', 'api', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
        return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
      });
    const strip = (x: string) =>
      x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    /** file -> why it calls a model without writing ai_usage itself. */
    const INFRA: Record<string, string> = {
      'lib/ai/gemini-keys.ts': 'the failover client itself',
      'lib/ai/eval/judge.ts': 'offline evaluation harness, never serves a merchant',
      'lib/search/embedding-provider.ts':
        'search embeddings: platform infra, not a merchant AI feature',
    };
    const MODEL = /\.generateContent\(|\bai\.run\(|\bAI\.run\(/g;
    const RECORD = /\brecord\w*Usage\(/g;
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).split(sep).join('/');
      if (rel in INFRA) continue;
      const src = strip(readFileSync(f, 'utf8'));
      const m = (src.match(MODEL) ?? []).length;
      if (!m) continue;
      scanned++;
      const r = (src.match(RECORD) ?? []).length;
      if (r < m) offenders.push(`${rel}: ${m} model call(s), ${r} usage record(s)`);
    }
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
