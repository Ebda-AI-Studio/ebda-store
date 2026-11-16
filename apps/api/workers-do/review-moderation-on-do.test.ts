import { describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';

// M-065 (SEC-2) on real workerd: a submitted review is born `pending` and the REAL moderation job only ever promotes it on a
// finite, low model score and a clean pre-filter. Anything else (model error, garbage reply, no score, a link) leaves it pending.
// Only the model and the quota/feature gates are stubbed; the review row, the store scope and the write are the real DO path.
const modelReply = vi.hoisted(() => ({
  fn: (async () => ({ response: { text: () => '' } })) as () => Promise<unknown>,
}));
vi.mock('../src/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return { generateContent: () => modelReply.fn() };
    }
  },
}));
vi.mock('../src/config', async () => {
  const actual = await vi.importActual<{ config: Record<string, unknown> }>('../src/config');
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (t, p) => (p === 'googleAiKey' ? 'k' : t[p as string]),
    }),
  };
});
vi.mock('../src/lib/ai-quota', () => ({ assertAiQuota: vi.fn() }));
vi.mock('../src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('../src/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));

import { reviewModeration } from '../src/lib/inngest/functions/review-moderation';

const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const S = '0d000000-0000-4000-8000-00000000000d';
const stub = () => e.STORE_DO.get(e.STORE_DO.idFromName(S));
const reply = (text: string) => (modelReply.fn = async () => ({ response: { text: () => text } }));

async function seedReview(id: string, body: string) {
  await runInDurableObject(stub(), (_i, st) => {
    const q = (sql: string, ...a: unknown[]) => st.storage.sql.exec(sql, ...a);
    q('PRAGMA foreign_keys = OFF');
    q(
      `INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      S,
      S
    );
    q(
      `INSERT INTO reviews (id, product_id, store_id, order_id, rating, body, language, status) VALUES (?, ?, ?, ?, 5, ?, 'en', 'pending')`,
      id,
      `p-${id}`,
      S,
      `o-${id}`,
      body
    );
  });
}
const row = (id: string) =>
  runInDurableObject(
    stub(),
    (_i, st) =>
      st.storage.sql.exec('SELECT status, spam_score FROM reviews WHERE id = ?', id).one() as {
        status: string;
        spam_score: number | null;
      }
  );
const run = (id: string) =>
  reviewModeration.handler({
    event: { name: 'review/submitted', data: { reviewId: id, storeId: S } },
    step: {
      run: async (_n: string, fn: () => unknown) => fn(),
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      sendEvent: async () => undefined,
    },
    runId: 't',
    attempt: 0,
  } as never);

describe('review moderation fails closed on the store DO', () => {
  it('setup', async () => {
    process.env.AI_BULK_THROTTLE_MS = '0';
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      "INSERT INTO stores (id, name, slug, owner_id, storage_backend, created_at, updated_at) VALUES (?1, 'N', ?1, 'o', 'do', 1, 1)"
    )
      .bind(S)
      .run();
  });

  it('a clean review with a low score is published (the positive control)', async () => {
    await seedReview('r-ok', 'Great product, fast delivery');
    reply('{"spamScore":0.05,"reasons":[]}');
    await run('r-ok');
    expect(await row('r-ok')).toMatchObject({ status: 'published', spam_score: 0.05 });
  });

  it.each(['{"reasons":[]}', '{"spamScore":null}', '{"spamScore":"0.01"}', 'I cannot help', ''])(
    'a model reply of %j leaves the stored review pending, never published',
    async text => {
      const id = `r-garbage-${Buffer.from(text).toString('hex').slice(-16) || 'empty'}`;
      await seedReview(id, 'Great product, fast delivery');
      reply(text);
      await run(id);
      expect(await row(id)).toMatchObject({ status: 'pending', spam_score: null });
    }
  );

  it('a model that THROWS fails the job and the stored review stays pending', async () => {
    await seedReview('r-throw', 'Great product, fast delivery');
    modelReply.fn = async () => {
      throw new Error('model down');
    };
    await expect(run('r-throw')).rejects.toBeTruthy();
    expect((await row('r-throw')).status).toBe('pending');
  });

  it('a review with a link is held for a human even when the model scores it 0', async () => {
    await seedReview('r-link', 'Nice, also see https://shop.example');
    reply('{"spamScore":0,"reasons":[]}');
    await run('r-link');
    expect((await row('r-link')).status).toBe('pending');
  });

  it('a high score is spam, hidden from the storefront', async () => {
    await seedReview('r-spam', 'Buy now');
    reply('{"spamScore":0.95,"reasons":["promo"]}');
    await run('r-spam');
    expect((await row('r-spam')).status).toBe('spam');
  });
});
