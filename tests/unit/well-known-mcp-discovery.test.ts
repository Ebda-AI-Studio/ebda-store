/**
 * Merchant MCP phase 4: `/.well-known/mcp/server-card.json`, `/.well-known/mcp.json`,
 * `/.well-known/agent-skills/index.json` and `/.well-known/agent-skills/<name>/SKILL.md`.
 * Same contract as acp.json (tests/unit/well-known-agent-discovery.test.ts): fail closed with an
 * indistinguishable 404, per-store URLs on the slug host AND a custom domain, never the open-writes
 * hatch, never merchant contact, cache class documented and applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const headerBag = { domain: null as string | null, slugSource: null as 'cookie' | null };
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve({
      get: (k: string) =>
        k === 'x-store-domain'
          ? headerBag.domain
          : k === 'x-store-slug-source'
            ? headerBag.slugSource
            : null,
    }),
}));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GET as cardGet } from '@web/app/.well-known/mcp/server-card.json/route';
import { GET as flatGet } from '@web/app/.well-known/mcp.json/route';
import { GET as indexGet } from '@web/app/.well-known/agent-skills/index.json/route';
import { GET as skillGet } from '@web/app/.well-known/agent-skills/[name]/SKILL.md/route';
import { STORE_MCP_TOOL_SKILLS, skillNameForTool } from '@ebda/shared';

function mockStore(o: { features?: string[]; status?: string; domain?: string | null } = {}) {
  const store = {
    id: 'store-1',
    name: 'Pecan Bee',
    nameAr: 'بيكان بي',
    slug: 'pecanbee',
    email: 'hi@pecanbee.test',
    phone: '+96500000000',
    domain: o.domain ?? null,
    currency: 'EGP',
    status: o.status ?? 'active',
  };
  fetchMock.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({ data: { store, enabledFeatures: o.features ?? ['agent_checkout'] } }),
  });
}
const skillReq = (name: string) =>
  skillGet(new Request('http://x'), { params: Promise.resolve({ name }) });

beforeEach(() => {
  vi.clearAllMocks();
  headerBag.domain = 'pecanbee.ebda.app';
  headerBag.slugSource = null;
});

describe('server card', () => {
  it('serves the MCP endpoint, auth contract and tools; same body on both paths', async () => {
    mockStore();
    const a = await (await cardGet()).text();
    const b = await (await flatGet()).text();
    expect(a).toBe(b);
    const j = JSON.parse(a);
    expect(j.remotes[0]).toEqual({
      type: 'streamable-http',
      url: expect.stringMatching(/\/mcp\/pecanbee$/),
    });
    expect(j.authentication).toMatchObject({
      read: 'none',
      write: 'api_key',
      write_header: 'x-agent-key',
    });
    expect(j.capabilities.tools.write).toEqual(['add_to_cart', 'place_order']);
    expect(j.title_localized).toEqual({ ar: 'بيكان بي' });
  });

  it('never discloses the open-writes hatch nor merchant contact', async () => {
    mockStore({ features: ['agent_checkout', 'agent_checkout_open_writes'] });
    const text = await (await cardGet()).text();
    expect(JSON.parse(text).authentication.write).toBe('api_key');
    expect(text).not.toMatch(/open_writes|pecanbee\.test|\+9650/);
  });

  it('custom domain: document URLs are rooted at the custom domain, not the platform', async () => {
    headerBag.domain = 'demo-shop.example';
    mockStore({ domain: 'demo-shop.example' });
    const j = JSON.parse(await (await cardGet()).text());
    expect(j.documents.skills).toBe(
      'https://demo-shop.example/.well-known/agent-skills/index.json'
    );
  });

  it('bounded-stale cache class: public 300s keyed by host; cookie fallback goes private', async () => {
    mockStore();
    expect((await cardGet()).headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=300'
    );
    headerBag.slugSource = 'cookie';
    expect((await cardGet()).headers.get('cache-control')).toBe('private, max-age=300');
  });
});

describe('fail closed, indistinguishable', () => {
  it.each([
    ['feature off', () => mockStore({ features: [] })],
    ['inactive store', () => mockStore({ status: 'suspended' })],
    [
      'platform host',
      () => {
        headerBag.domain = null;
      },
    ],
  ])('404s: %s', async (_n, setup) => {
    setup();
    const bodies: string[] = [];
    for (const r of [
      await cardGet(),
      await flatGet(),
      await indexGet(),
      await skillReq('get-product'),
    ]) {
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('unknown skill name 404s with the same body', async () => {
    mockStore();
    const r = await skillReq('admin-list-orders');
    expect(r.status).toBe(404);
    expect(await r.text()).toBe(JSON.stringify({ error: 'not_found' }));
  });
});

describe('agent skills', () => {
  it('index lists a skill per tool, each URL resolves and its digest matches the served bytes', async () => {
    mockStore();
    const idx = JSON.parse(await (await indexGet()).text());
    const names = idx.skills.map((s: { name: string }) => s.name);
    for (const t of STORE_MCP_TOOL_SKILLS) expect(names).toContain(skillNameForTool(t.name));
    for (const s of idx.skills) {
      expect(s.url).toBe(`https://pecanbee.ebda.app/.well-known/agent-skills/${s.name}/SKILL.md`);
      const res = await skillReq(s.name);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
      const text = await res.text();
      expect(s.digest).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
    }
  });

  it('write-tool skills state the credential; no skill names an admin tool', async () => {
    mockStore();
    const w = await (await skillReq('place-order')).text();
    expect(w).toContain('x-agent-key');
    const idx = JSON.parse(await (await indexGet()).text());
    expect(JSON.stringify(idx)).not.toMatch(/admin_|merchant/);
  });
});
