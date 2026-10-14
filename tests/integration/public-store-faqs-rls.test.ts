/**
 * Public store payloads keep their FAQs + how-tos under enforced RLS.
 *
 * Regression for the 2026-09-25 cutover rollback: with the API on the
 * non-bypass `ebda_app` role, `GET /public/stores/:slugOrId` and
 * `GET /public/store/resolve` returned `faqs: []` / `howtos: []` for stores
 * with 24/9 active rows. `store_faqs` / `store_howtos` have STRICT policies
 * (no contextless allowance) and the routes read them as a nested
 * `store.faqs` select outside any tenant context, so RLS filtered every row
 * away. Nothing errored and every existing test stayed green, because none
 * asserted what the payload CONTAINED.
 *
 * CI's integration job runs the API server as `ebda_app` (see ci.yml
 * "Give ebda_app a CI-only login for the API server"), so this file exercises
 * the real enforced path. Fixtures are written through the test harness's
 * superuser connection.
 *
 * Retry-safe: every fixture is keyed on a per-CALL unique suffix, and the
 * public store cache is keyed on slug / domain, so a retry gets fresh keys.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function makeStore() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `faq-rls-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'Faq',
      lastName: 'Rls',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `FAQ RLS ${suffix}`,
      slug: `faq-rls-${suffix}`,
      domain: `faq-rls-${suffix}.test`,
      // Only a VERIFIED domain resolves (SP5 task 4); this fixture is one.
      domainStatus: 'active',
      ownerId: owner.id,
      status: 'active',
      plan: 'enterprise',
      marketingPixels: {},
    },
  });
  created.storeIds.push(store.id);
  for (let i = 0; i < 3; i++) {
    await prisma.storeFaq.create({
      data: { storeId: store.id, question: `Q${i}`, answer: `A${i}`, orderIndex: i },
    });
  }
  // Inactive rows must still be filtered out — proves the fix kept `isActive`.
  await prisma.storeFaq.create({
    data: { storeId: store.id, question: 'hidden', answer: 'x', orderIndex: 9, isActive: false },
  });
  for (let i = 0; i < 2; i++) {
    await prisma.storeHowto.create({
      data: {
        storeId: store.id,
        title: `How ${i}`,
        description: 'd',
        steps: [{ name: 's', text: 't' }],
        orderIndex: i,
      },
    });
  }
  return store;
}

afterAll(async () => {
  await prisma.storeFaq.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.storeHowto.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

type StorePayload = {
  success: boolean;
  data: { store: { faqs: Array<{ question: string }>; howtos: Array<{ title: string }> } };
};

function expectFaqsAndHowtos(body: StorePayload) {
  expect(body.success).toBe(true);
  expect(body.data.store.faqs.map(f => f.question)).toEqual(['Q0', 'Q1', 'Q2']);
  expect(body.data.store.howtos.map(h => h.title)).toEqual(['How 0', 'How 1']);
}

describe('public store payloads under enforced RLS (store_faqs / store_howtos)', () => {
  it('GET /public/stores/:slug returns the active FAQs and how-tos', async () => {
    const store = await makeStore();
    const res = await fetch(`${API_BASE}/public/stores/${store.slug}`);
    expect(res.status).toBe(200);
    expectFaqsAndHowtos((await res.json()) as StorePayload);
  });

  it('GET /public/stores/:id returns the active FAQs and how-tos', async () => {
    const store = await makeStore();
    const res = await fetch(`${API_BASE}/public/stores/${store.id}`);
    expect(res.status).toBe(200);
    expectFaqsAndHowtos((await res.json()) as StorePayload);
  });

  it('GET /public/store/resolve (x-store-domain) returns the active FAQs and how-tos', async () => {
    const store = await makeStore();
    const res = await fetch(`${API_BASE}/public/store/resolve`, {
      headers: { 'x-store-domain': store.domain! },
    });
    expect(res.status).toBe(200);
    expectFaqsAndHowtos((await res.json()) as StorePayload);
  });

  it("never returns another store's FAQs", async () => {
    const a = await makeStore();
    const b = await makeStore();
    await prisma.storeFaq.create({
      data: { storeId: b.id, question: 'only-in-b', answer: 'x', orderIndex: 0 },
    });
    const res = await fetch(`${API_BASE}/public/stores/${a.slug}`);
    const body = (await res.json()) as StorePayload;
    expect(body.data.store.faqs.map(f => f.question)).not.toContain('only-in-b');
  });
});
