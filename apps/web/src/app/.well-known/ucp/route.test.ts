import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * audit-followup #1732 (scoped-audit P2 follow-up on PR #1942): same class
 * as acp.json — a cookie-fallback-resolved store must not be shared-
 * cacheable (Vary: Cookie alone doesn't help on Cloudflare); a URL/domain-
 * resolved store stays public+s-maxage.
 */

let viaCookie = false;

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'store.force-ai.co' }),
}));

vi.mock('../../../lib/agent-store-resolver', () => ({
  resolveAgentStore: vi.fn(),
  resolvedViaCookie: async () => viaCookie,
  storefrontBaseUrl: () => 'https://store.force-ai.co/test-store',
}));

import { resolveAgentStore } from '../../../lib/agent-store-resolver';
import { GET } from './route';

const mockResolveAgentStore = resolveAgentStore as unknown as ReturnType<typeof vi.fn>;

const STORE = {
  id: 'store_1',
  name: 'Test Store',
  slug: 'test-store',
  currency: 'EGP',
  enabledFeatures: ['agent_checkout'],
};

describe('GET /.well-known/ucp — shared-cacheability by resolution source', () => {
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
