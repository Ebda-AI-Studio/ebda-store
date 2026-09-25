/**
 * Storefront ↔ API path contract for the customer wallet (D1).
 *
 * The wallet router is mounted at the bare `/stores` prefix and declares its
 * customer paths as `/public/:storeId/wallet…`, so the real URL is
 * `/api/v1/stores/public/:storeId/wallet`. `/api/v1/public/:storeId/…` is a
 * DIFFERENT router (public.routes.ts) and 404s — which is exactly how the
 * storefront's loyalty page came to call a path that does not exist in
 * production (`GET /api/v1/public/<id>/loyalty/my-points` → 404, measured
 * 2026-09-25). This pins all three halves of the wallet's path so the same
 * drift fails here instead of silently hiding the wallet.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('customer wallet — storefront/API path contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('the API mounts the wallet router under /stores', () => {
    const index = readFileSync(path.join(ROOT, 'apps/api/src/routes/index.ts'), 'utf8');
    expect(index).toMatch(/router\.use\('\/stores', tenantContext, walletRoutes\)/);
  });

  it('the wallet router declares /public/:storeId/wallet and …/transactions', () => {
    const routes = readFileSync(path.join(ROOT, 'apps/api/src/routes/wallet.routes.ts'), 'utf8');
    expect(routes).toContain("'/public/:storeId/wallet',");
    expect(routes).toContain("'/public/:storeId/wallet/transactions',");
  });

  it('the storefront client calls /stores/public/:storeId/wallet(…)', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const { api } = await import('../../apps/web/src/lib/api');
    await api.getWallet('store-1');
    await api.getWalletTransactions('store-1', 'cursor-1');

    expect(calls[0]).toMatch(/\/api\/v1\/stores\/public\/store-1\/wallet$/);
    expect(calls[1]).toMatch(
      /\/api\/v1\/stores\/public\/store-1\/wallet\/transactions\?cursor=cursor-1$/
    );
  });
});
