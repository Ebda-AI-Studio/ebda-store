/**
 * `/.well-known/acp.json` and `/.well-known/ucp` — agent discovery documents.
 *
 * These are the path an agent checks BY CONVENTION, where `/llms.txt` is the
 * one it has to think to read. They grant nothing: every capability they name
 * is already built and already enforced elsewhere. What they must get right is
 * narrower, and all three are tested here:
 *
 *  1. **Fail closed, indistinguishably.** A store without `agent_checkout`,
 *     an inactive store and a platform-level request all 404 with the same
 *     body. A document that says "this store exists but will not sell to you"
 *     is a capability leak with no upside for the agent.
 *  2. **They never disclose the open-writes escape hatch.** Both documents
 *     always advertise writes as requiring `x-agent-key`, even for a store
 *     with `agent_checkout_open_writes` on — these documents are public and
 *     unauthenticated, so branching the disclosure on the hatch would let
 *     anyone enumerate which stores accept an uncredentialed `place_order`.
 *     An open store still accepts a keyless write; the documents just never
 *     confirm the posture either way (scoped-audit P2 on PR #1942).
 *  3. **Custom-domain merchants get their OWN URLs.** A platform-rooted link
 *     served on `wadyaljuz.com` sends the agent to a redirect at best. This is
 *     the bug `/llms.txt` actually shipped with once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const headerBag = {
  // Store identity is the Host alone: middleware sets `x-store-domain` to the
  // request host (`<slug>.ebda.app` or a custom domain); `slug` is a retired
  // header kept here only to prove it is ignored.
  slug: null as string | null,
  domain: null as string | null,
  host: 'ebda.app',
  // 'cookie' mirrors middleware.ts's x-store-slug-source signal (set only on
  // the sticky-cookie fallback branch, cleared everywhere else) — see
  // resolvedViaCookie() in apps/web/src/lib/agent-store-resolver.ts.
  slugSource: null as 'cookie' | null,
};

vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve({
      get: (k: string) => {
        if (k === 'x-store-slug') return headerBag.slug;
        if (k === 'x-store-domain') return headerBag.domain;
        if (k === 'host') return headerBag.host;
        if (k === 'x-store-slug-source') return headerBag.slugSource;
        return null;
      },
    }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GET as acpGet } from '@web/app/.well-known/acp.json/route';
import { GET as ucpGet } from '@web/app/.well-known/ucp/route';

interface StoreOpts {
  slug?: string;
  domain?: string | null;
  status?: string;
  features?: string[];
  currency?: string;
}

function mockStore(o: StoreOpts = {}) {
  const store = {
    id: 'store-1',
    name: 'Pecan Bee',
    slug: o.slug ?? 'pecanbee',
    description: 'Cakes',
    email: 'hi@pecanbee.test',
    phone: '+96500000000',
    domain: o.domain ?? null,
    currency: o.currency ?? 'KWD',
    status: o.status ?? 'active',
  };
  fetchMock.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({ data: { store, enabledFeatures: o.features ?? ['agent_checkout'] } }),
  });
  return store;
}

const body = async (res: Response) => JSON.parse(await res.text());

beforeEach(() => {
  vi.clearAllMocks();
  headerBag.slug = null;
  headerBag.domain = 'pecanbee.ebda.app';
  headerBag.host = 'pecanbee.ebda.app';
  headerBag.slugSource = null;
});

describe('acp.json', () => {
  it('serves the merchant, its MCP endpoint and its tool split', async () => {
    mockStore();
    const res = await acpGet();
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.merchant.name).toBe('Pecan Bee');
    expect(b.endpoints.mcp).toMatch(/\/mcp\/pecanbee$/);
    expect(b.endpoints.mcp_transport).toBe('streamable-http');
    expect(b.tools.write).toEqual(['add_to_cart', 'place_order']);
  });

  it('states the credential contract for writes, and none for reads', async () => {
    mockStore();
    const b = await body(await acpGet());
    expect(b.authentication.read).toBe('none');
    expect(b.authentication.write).toBe('api_key');
    expect(b.authentication.write_header).toBe('x-agent-key');
  });

  it('still advertises the credentialed shape when the per-store escape hatch is on', async () => {
    // This document is PUBLIC and unauthenticated — branching the
    // disclosure on the hatch would let anyone enumerate which stores
    // accept an uncredentialed place_order via one probe per merchant
    // domain. An open store still accepts a keyless write (the MCP auth
    // layer decides that at request time, not this document); the
    // discovery document just never confirms the posture either way
    // (scoped-audit P2 on PR #1942).
    mockStore({ features: ['agent_checkout', 'agent_checkout_open_writes'] });
    const b = await body(await acpGet());
    expect(b.authentication.write).toBe('api_key');
    expect(b.authentication.write_header).toBe('x-agent-key');
  });

  it('404s a store without agent_checkout — fail closed', async () => {
    mockStore({ features: [] });
    expect((await acpGet()).status).toBe(404);
  });

  it('404s an inactive store — a suspended shop cannot transact', async () => {
    mockStore({ status: 'suspended' });
    expect((await acpGet()).status).toBe(404);
  });

  it('404s a platform-level request — the platform is not a shop', async () => {
    headerBag.domain = null;
    headerBag.host = 'ebda.app';
    expect((await acpGet()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives all three refusals a byte-identical body', async () => {
    const bodies: string[] = [];
    mockStore({ features: [] });
    bodies.push(await (await acpGet()).text());
    mockStore({ status: 'suspended' });
    bodies.push(await (await acpGet()).text());
    headerBag.domain = null;
    bodies.push(await (await acpGet()).text());
    expect(new Set(bodies).size).toBe(1);
  });

  it('roots URLs at the merchant OWN domain when they have one', async () => {
    headerBag.slug = null;
    headerBag.domain = 'wadyaljuz.com';
    headerBag.host = 'wadyaljuz.com';
    mockStore({ slug: 'wadyaljuz', domain: 'wadyaljuz.com' });
    const b = await body(await acpGet());
    expect(b.merchant.url).toBe('https://wadyaljuz.com');
    expect(b.endpoints.product_feed).toBe('https://wadyaljuz.com/feeds/products.json');
    expect(b.endpoints.llms_txt).toBe('https://wadyaljuz.com/llms.txt');
  });

  it('roots URLs at <slug>.ebda.app for a store with no custom domain (never a path on the apex)', async () => {
    mockStore({ slug: 'pecanbee', domain: null });
    const b = await body(await acpGet());
    expect(b.merchant.url).toBe('https://pecanbee.ebda.app');
    expect(b.endpoints.llms_txt).toBe('https://pecanbee.ebda.app/llms.txt');
  });

  it('ignores a retired x-store-slug header: it never names a store', async () => {
    headerBag.domain = null;
    headerBag.slug = 'pecanbee';
    mockStore();
    expect((await acpGet()).status).toBe(404);
  });

  it('does not advertise returns — there is no agent-facing tool for them', async () => {
    mockStore();
    const b = await body(await acpGet());
    expect(b.capabilities.returns).toBe(false);
  });

  it('is cached briefly and shared-cacheable when resolved from the Host', async () => {
    mockStore();
    const res = await acpGet();
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('stays shared-cacheable on a custom domain (the 3 live stores) — same as a store subdomain', async () => {
    headerBag.slug = null;
    headerBag.domain = 'wadyaljuz.com';
    headerBag.host = 'wadyaljuz.com';
    mockStore({ slug: 'wadyaljuz', domain: 'wadyaljuz.com' });
    const res = await acpGet();
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('drops shared-cacheability when resolved via the sticky cookie fallback', async () => {
    // The exact shape middleware.ts produces for a bare `/.well-known/acp.json`
    // request with no slug in the URL: x-store-slug set from the cookie, plus
    // x-store-slug-source: cookie. Vary: Cookie alone doesn't stop Cloudflare
    // from replaying this response across visitors (edge-cache.ts), so the
    // response must not authorize shared caching at all (scoped-audit P2 on
    // PR #1942).
    headerBag.slugSource = 'cookie';
    mockStore();
    const res = await acpGet();
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('cache-control')).not.toMatch(/s-maxage/);
    expect(res.headers.get('vary')).toBeNull();
  });
});

describe('ucp', () => {
  it('points at the SAME endpoint and the same credential as acp.json', async () => {
    mockStore();
    const acp = await body(await acpGet());
    mockStore();
    const ucp = await body(await ucpGet());
    expect(ucp.transports[0].url).toBe(acp.endpoints.mcp);
    expect(ucp.transports[0].auth.write).toBe('api_key');
    expect(ucp.transports[0].auth.header).toBe(acp.authentication.write_header);
  });

  it('still advertises the credentialed shape when the per-store escape hatch is on, agreeing with acp.json', async () => {
    // Same non-disclosure rule as acp.json: this document is public, so it
    // never confirms whether a store's open-writes hatch is on
    // (scoped-audit P2 on PR #1942).
    mockStore({ features: ['agent_checkout', 'agent_checkout_open_writes'] });
    const b = await body(await ucpGet());
    expect(b.transports[0].auth.write).toBe('api_key');
    expect(b.transports[0].auth.header).toBe('x-agent-key');
  });

  it('declares KWD as 1000 minor units — the 10x trap', async () => {
    mockStore({ currency: 'KWD' });
    const b = await body(await ucpGet());
    expect(b.pricing.amounts).toBe('integer-minor-units');
    expect(b.pricing.minor_units_per_major).toBe(1000);
  });

  it('declares 100 minor units for a two-decimal currency', async () => {
    mockStore({ currency: 'USD' });
    const b = await body(await ucpGet());
    expect(b.pricing.minor_units_per_major).toBe(100);
  });

  it('404s when agent_checkout is off, same as its sibling', async () => {
    mockStore({ features: [] });
    expect((await ucpGet()).status).toBe(404);
  });

  it('cross-links to acp.json on the right host', async () => {
    headerBag.slug = null;
    headerBag.domain = 'wadyaljuz.com';
    headerBag.host = 'wadyaljuz.com';
    mockStore({ slug: 'wadyaljuz', domain: 'wadyaljuz.com' });
    const b = await body(await ucpGet());
    expect(b.documents.acp).toBe('https://wadyaljuz.com/.well-known/acp.json');
  });

  it('is shared-cacheable when resolved from the Host, same as acp.json', async () => {
    mockStore();
    const res = await ucpGet();
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('stays shared-cacheable on a custom domain (the 3 live stores)', async () => {
    headerBag.slug = null;
    headerBag.domain = 'wadyaljuz.com';
    headerBag.host = 'wadyaljuz.com';
    mockStore({ slug: 'wadyaljuz', domain: 'wadyaljuz.com' });
    const res = await ucpGet();
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('drops shared-cacheability when resolved via the sticky cookie fallback', async () => {
    headerBag.slugSource = 'cookie';
    mockStore();
    const res = await ucpGet();
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('cache-control')).not.toMatch(/s-maxage/);
    expect(res.headers.get('vary')).toBeNull();
  });
});
