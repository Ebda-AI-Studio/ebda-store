/**
 * AI-first Autofill Integration Tests
 *
 * Exercises the fill core (`fillProductFields`) against a real database with
 * the Gemini-backed `AIService` mocked, plus the provenance override
 * guarantee and the hand-back-to-AI reset flow.
 *
 * Non-destructive: creates its own user + store + product in beforeAll and
 * removes exactly those rows in afterAll. No TRUNCATE — safe to run against
 * any environment's database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@ebda/database';
import { AIService } from '../../apps/api/src/services/ai.service';
import { fillProductFields } from '../../apps/api/src/services/ai-autofill.service';

// Mock the whole AIService module so the fill core never calls Gemini (no
// network, no quota, no GOOGLE_GENERATIVE_AI_KEY required in CI). vi.mock is
// hoisted and replaces the module at import time.
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: {
    translate: vi.fn(),
    suggestSeo: vi.fn(),
    suggestCategories: vi.fn(),
  },
}));

// The global tests/setup.ts runs vi.clearAllMocks() in beforeEach and
// vi.restoreAllMocks() in afterEach, which would wipe top-level mock
// implementations. Re-apply them in a local beforeEach (runs AFTER the global
// one) so every test gets deterministic AI outputs.
beforeEach(() => {
  vi.mocked(AIService.translate).mockResolvedValue({ translation: 'اسم عربي', cached: false });
  vi.mocked(AIService.suggestSeo).mockResolvedValue({
    suggestion: {
      title: 'SEO Title',
      titleAr: 'عنوان',
      description: 'SEO description',
      descriptionAr: 'وصف',
      keywords: ['a', 'b'],
    },
    cached: false,
  });
  vi.mocked(AIService.suggestCategories).mockResolvedValue({ suggestions: [], cached: false });
});

const SUFFIX = `ai-autofill-${Date.now()}`;
let userId: string;
let storeId: string;
let productId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${SUFFIX}@test.local`,
      passwordHash: 'x',
      firstName: 'AI',
      lastName: 'Autofill',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = user.id;

  const store = await prisma.store.create({
    data: {
      name: 'AI Autofill Test Store',
      slug: `store-${SUFFIX}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
    },
  });
  storeId = store.id;

  const product = await prisma.product.create({
    data: { storeId, name: 'Blue Ceramic Mug', slug: `mug-${SUFFIX}`, price: 1500 },
  });
  productId = product.id;
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('fillProductFields', () => {
  it('on create fills Arabic + SEO and stamps them ai', async () => {
    const res = await fillProductFields(storeId, productId, { op: 'create' });
    expect(res.filled).toBeGreaterThan(0);

    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('اسم عربي');
    expect(p?.metaTitle).toBe('SEO Title');
    const sources = p?.aiFieldSources as Record<string, string>;
    expect(sources.nameAr).toBe('ai');
    expect(sources.metaTitle).toBe('ai');
  });

  it('never overwrites legacy content that has no provenance entry', async () => {
    // A pre-feature product: real human content in BOTH languages, but empty
    // aiFieldSources (no provenance). The engine must NOT clobber it even
    // though computeFillSet classifies the fields as "empty".
    await prisma.product.update({
      where: { id: productId },
      data: {
        name: 'Legacy English Name',
        nameAr: 'اسم قديم يدوي',
        aiFieldSources: {},
      },
    });

    await fillProductFields(storeId, productId, { op: 'sweep' });

    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.name).toBe('Legacy English Name'); // untouched
    expect(p?.nameAr).toBe('اسم قديم يدوي'); // untouched
    // and the engine did not falsely claim ownership of them
    const s = (p?.aiFieldSources as Record<string, string>) ?? {};
    expect(s.name).toBeUndefined();
    expect(s.nameAr).toBeUndefined();
  });

  it('never overwrites a human-owned field', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { name: 'Blue Ceramic Mug', description: null, descriptionAr: null },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { nameAr: 'اسم يدوي', aiFieldSources: { nameAr: 'human' } },
    });

    await fillProductFields(storeId, productId, { op: 'update', changedFields: ['name'] });

    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('اسم يدوي'); // untouched — merchant owns it
    expect((p?.aiFieldSources as Record<string, string>).nameAr).toBe('human');
  });

  it('hand-back-to-AI: clearing the lock lets a single field regenerate', async () => {
    // Simulate the reset-field endpoint: drop value + provenance, then refill
    // only that field.
    // Ensure product has a name for translation to work from
    await prisma.product.update({
      where: { id: productId },
      data: { name: 'Blue Ceramic Mug', nameAr: null, aiFieldSources: {} },
    });

    await fillProductFields(storeId, productId, { op: 'create', onlyFields: ['nameAr'] });

    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('اسم عربي'); // regenerated
    expect((p?.aiFieldSources as Record<string, string>).nameAr).toBe('ai');
  });
});
