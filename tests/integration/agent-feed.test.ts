/**
 * Integration tests for GET /public/feed/products.json (agent_feed add-on).
 *
 * Requires a real Postgres DB (via DATABASE_URL) and real Redis (via REDIS_URL);
 * CI provides both via service containers. Hits a real running API server at
 * localhost:4000 — mirrors the setup pattern of
 * tests/integration/feature-flag-enforcement.test.ts.
 *
 * Tests:
 *  1. Feature disabled (no StoreFeature row, key in no plan baseline) → 404.
 *  2. Feature enabled via StoreFeature upsert → 200, feed shape correct.
 *  3. Draft products excluded from the feed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';

const API_URL = process.env.API_URL || 'http://localhost:4000/api/v1';

let storeId: string;
let ownerId: string;
let activeProductId: string;
let draftProductId: string;

const TEST_STORE_SLUG = `agent-feed-test-${Date.now()}`;
const ACTIVE_SLUG = `olive-oil-1l-${Date.now()}`;

async function enableAgentFeed(): Promise<void> {
  await prisma.storeFeature.upsert({
    where: { storeId_featureKey: { storeId, featureKey: 'agent_feed' } },
    create: { storeId, featureKey: 'agent_feed', enabled: true },
    update: { enabled: true },
  });
}

async function clearAgentFeedOverride(): Promise<void> {
  await prisma.storeFeature
    .delete({ where: { storeId_featureKey: { storeId, featureKey: 'agent_feed' } } })
    .catch(() => {
      /* no-op if it doesn't exist */
    });
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `agent-feed-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Agent',
      lastName: 'Feed',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  ownerId = owner.id;

  const store = await prisma.store.create({
    data: {
      name: 'Agent Feed Test Store',
      slug: TEST_STORE_SLUG,
      ownerId,
      // No plan baseline includes agent_feed, so start on any plan — the
      // feature stays disabled until explicitly enabled via StoreFeature.
      plan: 'starter',
      status: 'active',
      currency: 'KWD',
    },
  });
  storeId = store.id;

  const active = await prisma.product.create({
    data: {
      storeId,
      name: 'Olive Oil 1L',
      nameAr: 'زيت زيتون ١ لتر',
      slug: ACTIVE_SLUG,
      description: 'Cold pressed.',
      price: 12500,
      inventory: 10,
      trackInventory: true,
      status: 'active',
    },
  });
  activeProductId = active.id;

  const draft = await prisma.product.create({
    data: {
      storeId,
      name: 'Unreleased Product',
      slug: `unreleased-${Date.now()}`,
      price: 5000,
      inventory: 5,
      trackInventory: true,
      status: 'draft',
    },
  });
  draftProductId = draft.id;
});

afterAll(async () => {
  await prisma.storeFeature.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.product
    .deleteMany({ where: { id: { in: [activeProductId, draftProductId] } } })
    .catch(() => {});
  await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
});

describe('GET /public/feed/products.json — agent_feed add-on', () => {
  it('returns 404 when agent_feed is disabled (no StoreFeature row)', async () => {
    const res = await fetch(`${API_URL}/public/feed/products.json`, {
      headers: { 'X-Store-ID': storeId },
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 with the feed once agent_feed is enabled via StoreFeature', async () => {
    await enableAgentFeed();

    const res = await fetch(`${API_URL}/public/feed/products.json`, {
      headers: { 'X-Store-ID': storeId },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.product_count).toBe(1);
    expect(Array.isArray(body.products)).toBe(true);

    const item = body.products[0];
    expect(item.title).toBe('Olive Oil 1L');
    expect(item.link.endsWith(`/products/${ACTIVE_SLUG}`)).toBe(true);
    expect(item.price).toMatch(/^\d+\.\d{3} KWD$/);
    expect(item.availability).toBe('in_stock');

    await clearAgentFeedOverride();
  });

  it('excludes draft/archived products from the feed', async () => {
    await enableAgentFeed();

    const res = await fetch(`${API_URL}/public/feed/products.json`, {
      headers: { 'X-Store-ID': storeId },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.product_count).toBe(1);
    expect(body.products.some((p: { item_id: string }) => p.item_id === draftProductId)).toBe(
      false
    );

    await clearAgentFeedOverride();
  });
});
