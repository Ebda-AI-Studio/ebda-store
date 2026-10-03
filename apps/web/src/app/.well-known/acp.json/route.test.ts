import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * audit-followup #1732 (scoped-audit P2 follow-up on PR #1942):
 * `resolveAgentStore()` can resolve the store from the sticky `x-store-slug`
 * COOKIE (middleware.ts's fallback for a subroute with no slug segment in
 * the URL — this exact path) rather than the URL itself. The response —
 * merchant name/description/contact email/phone, keyed by whichever store
 * the cookie pointed at — must not be shared-cacheable in that case: the
 * same request line can answer with a different merchant's data depending
 * on which visitor's cookie it carried, and `Vary: Cookie` alone does not
 * close this on Cloudflare (its cache ignores Vary outside an
 * Enterprise-only feature — see apps/api/src/lib/edge-cache.ts). A URL slug
 * segment or custom-domain Host resolution stays public+s-maxage.
 */

let viaCookie = false;

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'ebda.app' }),
}));

vi.mock('../../../lib/agent-store-resolver', () => ({
  resolveAgentStore: vi.fn(),
  resolvedViaCookie: async () => viaCookie,
  storefrontBaseUrl: () => 'https://ebda.app/test-store',
}));

import { resolveAgentStore } from '../../../lib/agent-store-resolver';
import { GET } from './route';

const mockResolveAgentStore = resolveAgentStore as unknown as ReturnType<typeof vi.fn>;

const STORE = {
  id: 'store_1',
  name: 'Test Store',
  slug: 'test-store',
  email: 'merchant@example.com',
  currency: 'KWD',
  enabledFeatures: ['agent_checkout'],
};

describe('GET /.well-known/acp.json — shared-cacheability by resolution source', () => {
  beforeEach(() => {
    mockResolveAgentStore.mockReset();
    viaCookie = false;
  });

  it('URL/domain resolution: public + s-maxage + Vary: Cookie', async () => {
    mockResolveAgentStore.mockResolvedValue(STORE);
    viaCookie = false;

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('cookie-fallback resolution: private, no shared-cache directive, no Vary', async () => {
    mockResolveAgentStore.mockResolvedValue(STORE);
    viaCookie = true;

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('cache-control')).not.toMatch(/s-maxage/);
    expect(res.headers.get('vary')).toBeNull();
  });
});
