/**
 * Task 8 review I2 + I3, proven as production runs: the guarded Prisma client on the strict-RLS
 * role `ebda_app` (both tenant layers on). Fixtures use the owner-role process client.
 *
 * - I2: the `product.upserted` autofill (read → generate → write steps) fills search words.
 * - I3: the daily `ai-autofill-sweep` per-store unit fills them too. Before the fix it ran with
 *   no store scope, so the tenant guard refused its first product query and every store "failed".
 *
 * Gemini is a fake client (no network, no key used); the real generator, quota check, usage row
 * and DB CHECK run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.hoisted(() => {
  process.env.AI_BULK_THROTTLE_MS = '0'; // the sweep paces on this; no real calls here
});
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
vi.mock('../../apps/api/src/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: vi.fn(function () {
    return {
      getGenerativeModel: () => ({
        generateContent: async () => ({
          response: { text: () => '{"terms":["كوتشي","kotshy","sneakers"]}', usageMetadata: {} },
        }),
      }),
    };
  }),
}));
vi.mock('../../apps/api/src/config', async importOriginal => {
  const mod = await importOriginal<typeof import('../../apps/api/src/config')>();
  return { ...mod, config: { ...mod.config, googleAiKey: 'fake-key-for-tests' } };
});

const { handleAiAutofillProduct } =
  await import('../../apps/api/src/lib/inngest/functions/ai-autofill-product');
const { sweepAutofillStore } =
  await import('../../apps/api/src/lib/inngest/functions/ai-autofill-sweep');
const { inngest } = await import('../../apps/api/src/lib/inngest/client');
const { setEmbeddingProviderForTests, EMBED_MODEL } =
  await import('../../apps/api/src/lib/search/embedding-provider');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** Run as production does: the guarded client, on the strict-RLS role `ebda_app`. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);

function fakeStep() {
  const memo = new Map<string, unknown>();
  return {
    run: async (name: string, fn: () => Promise<unknown>) => {
      if (!memo.has(name)) memo.set(name, JSON.parse(JSON.stringify((await fn()) ?? null)));
      return memo.get(name);
    },
  };
}

const run = crypto.randomUUID().slice(0, 8);
let ownerId: string;
let storeId: string;
let categoryId: string;
const human = {
  name: 'human',
  nameAr: 'human',
  description: 'human',
  descriptionAr: 'human',
  metaTitle: 'human',
  metaTitleAr: 'human',
  metaDescription: 'human',
  metaDescriptionAr: 'human',
};

async function mkProduct(tag: string, status: 'active' | 'draft' = 'active') {
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Leather sneakers',
      nameAr: 'كوتشي جلد',
      description: 'White leather sneakers',
      descriptionAr: 'كوتشي جلد أبيض',
      metaTitle: 't',
      metaTitleAr: 't',
      metaDescription: 'd',
      metaDescriptionAr: 'd',
      slug: `aiapp-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}`,
      price: 1000,
      status,
      aiFieldSources: human,
    },
  });
  await prisma.productCategory.create({ data: { productId: p.id, categoryId } });
  return p.id;
}

describe.skipIf(!hasDb)('autofill under ebda_app + tenant guard (Task 8 review I2/I3)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `aiapp-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'I',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    ownerId = owner.id;
    const store = await prisma.store.create({
      data: {
        name: 'AI App Store',
        slug: `aiapp-${run}`,
        ownerId,
        plan: 'enterprise',
        status: 'active',
      },
    });
    storeId = store.id;
    const cat = await prisma.category.create({
      data: { storeId, name: 'Shoes', nameAr: 'أحذية', slug: `shoes-${run}` },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    await prisma.aiUsage.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.category.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('I2: the stepwise product.upserted autofill fills search words as ebda_app', async () => {
    const productId = await mkProduct('i2');
    // Task 11: a fill that writes search words asks the search indexer to look at the store.
    setEmbeddingProviderForTests({ model: EMBED_MODEL, embed: async () => [] });
    vi.mocked(inngest.send).mockClear();
    await asApp(() =>
      handleAiAutofillProduct({
        event: { data: { storeId, productId, op: 'create' } },
        step: fakeStep(),
      })
    );
    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.searchTerms).toBe('كوتشي, kotshy, sneakers');
    expect((p?.aiFieldSources as Record<string, string>).searchTerms).toBe('ai');
    expect(
      await prisma.aiUsage.count({ where: { storeId, feature: 'search-terms' } })
    ).toBeGreaterThan(0);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith({
      name: 'search/store.reindex-requested',
      data: { storeId, reason: 'ai-autofill' },
    });
    setEmbeddingProviderForTests(undefined);
  });

  it('I3: the daily sweep per-store unit fills search words as ebda_app (was refused unscoped)', async () => {
    const productId = await mkProduct('i3');
    const res = await asApp(() => sweepAutofillStore(storeId));
    expect(res.products).toBeGreaterThan(0);
    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.searchTerms).toBe('كوتشي, kotshy, sneakers');
    expect((p?.aiFieldSources as Record<string, string>).searchTerms).toBe('ai');
  });
});
