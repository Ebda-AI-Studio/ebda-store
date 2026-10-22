/**
 * Ruling SEARCH-URL-1: the WhatsApp bridge product search reads the shopper's text from the
 * `X-Search-Query` header (no URL, no log line); the deprecated `?q=` still answers for one release.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { searchProductIds, loggerCalls } = vi.hoisted(() => ({
  searchProductIds: vi.fn(),
  loggerCalls: [] as unknown[][],
}));
vi.mock('@ebda/database', () => ({
  prisma: { product: { findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock('@api/middleware/wa-bridge-auth', () => ({
  waBridgeAuth: (req: { bridgeStore?: unknown }, _res: unknown, next: () => void) => {
    req.bridgeStore = { id: 's1', currency: 'EGP' };
    next();
  },
}));
vi.mock('@api/middleware/wa-feature-gate', () => ({
  isWhatsappEnabled: () => true,
  FEATURE_DISABLED_BODY: {},
}));
vi.mock('@api/services/product-search.service', () => ({
  searchProductIds: (...a: unknown[]) => searchProductIds(...a),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/lib/logger', () => {
  const rec = (...a: unknown[]) => void loggerCalls.push(a);
  return { default: { error: rec, warn: rec, info: rec, debug: rec } };
});

import router from '@api/routes/wa-bridge.routes';

const PHONE = '01012345678';
const app = express().use('/wa', router);

beforeEach(() => {
  vi.clearAllMocks();
  loggerCalls.length = 0;
  searchProductIds.mockResolvedValue([]);
});

describe('GET /wa-bridge/products/search', () => {
  it('searches the header term, no ?q= needed, never edge-cacheable, nothing logged', async () => {
    const res = await request(app)
      .get('/wa/products/search')
      .set('X-Search-Query', encodeURIComponent(`منى ${PHONE}`));
    expect(res.status).toBe(200);
    expect(searchProductIds.mock.calls[0][1]).toBe(`منى ${PHONE}`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(loggerCalls)).not.toContain(PHONE);
  });

  it('the deprecated ?q= still answers', async () => {
    const res = await request(app).get('/wa/products/search?q=shoes');
    expect(res.status).toBe(200);
    expect(searchProductIds.mock.calls[0][1]).toBe('shoes');
  });

  it('no term at all is a 400', async () => {
    expect((await request(app).get('/wa/products/search')).status).toBe(400);
  });
});
