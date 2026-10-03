/**
 * MCP agent-write authorisation — the read/write split (Ruling M1).
 *
 * Three properties, each with its own failure mode in production:
 *
 *  1. **The tool classifier is TOTAL.** It runs in Express middleware on the
 *     ONE `POST /api/v1/mcp/:storeSlug` every MCP call rides. A `TypeError` in
 *     it reaches `next(err)` and 500s EVERY request — reads included — so a
 *     batched JSON-RPC ARRAY body, a `null` body, `{}`, a notification with no
 *     `params`, and an unknown tool name must all return a verdict rather than
 *     throw.
 *  2. **Writes require the credential; reads do not.** `assertAgentWrite`
 *     throws only when the `agent:write` scope is absent, and nothing in this
 *     path can reject a read or the `initialize` handshake, because it is only
 *     ever called from inside the two write tool handlers.
 *  3. **The credential resolver never rejects and is tenant-pinned.** Every
 *     path through `resolveAgentAuth` — no header, wrong key, a key belonging
 *     to another store, a DB error — returns an AuthInfo instead of throwing,
 *     with an empty `scopes` array. Read tools are therefore untouched by any
 *     credential failure whatsoever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStoreFindUnique = vi.fn();
const mockIsFeatureEnabled = vi.fn();

vi.mock('@force/database', () => ({
  prisma: { store: { findUnique: (...a: unknown[]) => mockStoreFindUnique(...a) } },
  runInTenantContext: vi.fn((_storeId: string, fn: () => unknown) => fn()),
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...a: unknown[]) => mockIsFeatureEnabled(...a) },
}));

vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The REAL encryption service is used (the AES-256-GCM round trip is part of
// what is being tested), so only its key source is stubbed. `config` reads
// ENCRYPTION_KEY at module load, which is hoisted above any plain assignment
// in this file — hence a mock, not a `process.env` write.
vi.mock('@api/config', () => ({
  config: { encryptionKey: 'test-encryption-key-for-ci-32chars' },
}));

import {
  AGENT_KEY_HEADER,
  AGENT_WRITE_SCOPE,
  assertAgentWrite,
  classifyToolCall,
  resolveAgentAuth,
} from '@api/mcp/agent-auth';
import { encryption } from '@api/services/encryption.service';
import type { McpStore } from '@api/mcp/resolve-store';
import type { Request } from 'express';

const storeA: McpStore = {
  id: 'store-a',
  name: 'Store A',
  slug: 'store-a',
  currency: 'EGP',
  domain: null,
};

function req(headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ip: '203.0.113.7',
    headers: lower,
    header: (n: string) => lower[n.toLowerCase()],
    get: (n: string) => lower[n.toLowerCase()],
  } as unknown as Request;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('classifyToolCall — must be a TOTAL function', () => {
  it('classifies a write tool call', () => {
    expect(
      classifyToolCall({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'place_order' } })
    ).toEqual({
      tool: 'place_order',
      kind: 'write',
    });
    expect(classifyToolCall({ method: 'tools/call', params: { name: 'add_to_cart' } })).toEqual({
      tool: 'add_to_cart',
      kind: 'write',
    });
  });

  it('classifies a read tool call', () => {
    expect(classifyToolCall({ method: 'tools/call', params: { name: 'search_products' } })).toEqual(
      {
        tool: 'search_products',
        kind: 'read',
      }
    );
    expect(classifyToolCall({ method: 'tools/call', params: { name: 'view_cart' } })).toEqual({
      tool: 'view_cart',
      kind: 'read',
    });
  });

  it.each([
    ['null body', null],
    ['undefined body', undefined],
    ['empty object', {}],
    ['a bare string', 'not json-rpc'],
    ['a number', 7],
    ['initialize', { method: 'initialize', params: { protocolVersion: '2025-06-18' } }],
    ['tools/list', { method: 'tools/list' }],
    ['a notification with no params', { method: 'notifications/initialized' }],
    ['tools/call with no params', { method: 'tools/call' }],
    ['tools/call with a non-object params', { method: 'tools/call', params: 'x' }],
    ['tools/call with a non-string name', { method: 'tools/call', params: { name: 42 } }],
    ['an unknown tool', { method: 'tools/call', params: { name: 'frobnicate' } }],
    ['an empty batch array', []],
    ['a batch of junk', [null, 3, {}]],
  ])('does not throw for %s', (_label, body) => {
    expect(() => classifyToolCall(body)).not.toThrow();
  });

  it('reports protocol messages as protocol, not as a tool', () => {
    expect(classifyToolCall({ method: 'initialize' })).toEqual({ tool: null, kind: 'protocol' });
    expect(classifyToolCall({ method: 'tools/list' })).toEqual({ tool: null, kind: 'protocol' });
  });

  it('reports an unknown tool name without pretending it is a read', () => {
    expect(classifyToolCall({ method: 'tools/call', params: { name: 'frobnicate' } })).toEqual({
      tool: 'frobnicate',
      kind: 'unknown',
    });
  });

  it('reports a BATCHED array body containing a write as a write', () => {
    const batch = [
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'search_products' } },
      { method: 'tools/call', params: { name: 'place_order' } },
    ];
    expect(classifyToolCall(batch)).toEqual({ tool: 'place_order', kind: 'write' });
  });

  it('reports null/{} as unknown rather than as a tool', () => {
    expect(classifyToolCall(null)).toEqual({ tool: null, kind: 'unknown' });
    expect(classifyToolCall({})).toEqual({ tool: null, kind: 'unknown' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('assertAgentWrite — the write gate', () => {
  it('refuses when there is no authInfo at all', () => {
    expect(() => assertAgentWrite('place_order', undefined)).toThrowError(
      /agent credential for write tools/i
    );
  });

  it('refuses when authInfo carries no agent:write scope', () => {
    const extra = { authInfo: { token: '', clientId: 'anonymous', scopes: [], extra: {} } };
    expect(() => assertAgentWrite('add_to_cart', extra)).toThrow();
  });

  it('permits when the agent:write scope is present, and returns the attribution context', () => {
    const extra = {
      authInfo: {
        token: 'fp',
        clientId: 'store:store-a',
        scopes: [AGENT_WRITE_SCOPE],
        extra: {
          storeSlug: 'store-a',
          ip: '198.51.100.4',
          userAgent: 'claude/1',
          credential: 'valid',
          grant: 'credential',
        },
      },
    };
    const ctx = assertAgentWrite('place_order', extra);
    expect(ctx.ip).toBe('198.51.100.4');
    expect(ctx.userAgent).toBe('claude/1');
    expect(ctx.grant).toBe('credential');
  });

  it('carries an ACTIONABLE message naming the header and the read tools', () => {
    try {
      assertAgentWrite('place_order', undefined);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(AGENT_KEY_HEADER);
      expect(msg).toContain('add_to_cart');
      expect(msg).toContain('search_products');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAgentAuth — never rejects, tenant-pinned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(false); // escape hatch OFF (the default)
  });

  it('returns an unauthorised AuthInfo for an anonymous request — reads are untouched', async () => {
    const auth = await resolveAgentAuth(req(), storeA);
    expect(auth.scopes).toEqual([]);
    expect(auth.clientId).toBe('anonymous');
    expect(auth.token).toBe('');
    expect((auth.extra as { credential: string }).credential).toBe('none');
    // No header, no lookup — an anonymous read costs nothing extra.
    expect(mockStoreFindUnique).not.toHaveBeenCalled();
  });

  it('grants agent:write for the store’s own key', async () => {
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: encryption.encrypt('fak_secret-a') });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_secret-a' }), storeA);
    expect(auth.scopes).toEqual([AGENT_WRITE_SCOPE]);
    expect((auth.extra as { grant: string }).grant).toBe('credential');
  });

  it('never puts the plaintext key in the AuthInfo — only a fingerprint', async () => {
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: encryption.encrypt('fak_secret-a') });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_secret-a' }), storeA);
    expect(auth.token).not.toBe('fak_secret-a');
    expect(auth.token).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(auth)).not.toContain('fak_secret-a');
  });

  it('refuses a WRONG key', async () => {
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: encryption.encrypt('fak_secret-a') });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_wrong' }), storeA);
    expect(auth.scopes).toEqual([]);
    expect((auth.extra as { credential: string }).credential).toBe('invalid');
  });

  it('refuses store B’s key on store A’s endpoint (tenant pinning by construction)', async () => {
    // Only ONE row is ever read — the store the slug resolved to. Store B's key
    // is simply not store A's key, so there is no cross-tenant match to make.
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: encryption.encrypt('fak_store-a-key') });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_store-b-key' }), storeA);
    expect(auth.scopes).toEqual([]);
    expect(mockStoreFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'store-a' } })
    );
  });

  it('refuses a REVOKED key (column nulled) without erroring', async () => {
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: null });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_secret-a' }), storeA);
    expect(auth.scopes).toEqual([]);
    expect((auth.extra as { credential: string }).credential).toBe('unconfigured');
  });

  it('degrades to unauthorised (never throws) when the credential lookup fails', async () => {
    mockStoreFindUnique.mockRejectedValue(new Error('db down'));
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_secret-a' }), storeA);
    expect(auth.scopes).toEqual([]);
    expect((auth.extra as { credential: string }).credential).toBe('error');
  });

  it('reports a DECRYPT failure as `error`, not as a bad key — it is our fault', async () => {
    // Changed 2026-09-09. This used to assert `invalid`, which locked in a
    // defect: the outcome field is the ONLY discriminator
    // `agent-write-denied-watch` has, so a wrong/rotated ENCRYPTION_KEY —
    // refusing every agent write on every store — was reported as callers
    // presenting bad keys and classified as a credential SWEEP, sending the
    // operator after an attacker while the platform stayed broken. `error`
    // routes it to the platform p0 that names ENCRYPTION_KEY as the fix, which
    // is what the AgentCredentialOutcome contract already said it meant.
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: 'not-valid-ciphertext' });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_secret-a' }), storeA);
    expect(auth.scopes).toEqual([]);
    expect((auth.extra as { credential: string }).credential).toBe('error');
  });

  it('still reports a decryptable key that simply does not match as `invalid`', async () => {
    // The other direction: `error` must not swallow the real bad-key case, or
    // a genuine probe would be reported as a platform fault.
    mockStoreFindUnique.mockResolvedValue({ agentApiKey: encryption.encrypt('fak_secret-a') });
    const auth = await resolveAgentAuth(req({ [AGENT_KEY_HEADER]: 'fak_nope' }), storeA);
    expect((auth.extra as { credential: string }).credential).toBe('invalid');
  });

  it('grants agent:write anonymously when the per-store ESCAPE HATCH is on', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const auth = await resolveAgentAuth(req(), storeA);
    expect(auth.scopes).toEqual([AGENT_WRITE_SCOPE]);
    expect((auth.extra as { grant: string }).grant).toBe('open_writes');
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('store-a', 'agent_checkout_open_writes');
  });

  it('keeps enforcement ON when the escape-hatch lookup itself fails (safe direction)', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('redis down'));
    const auth = await resolveAgentAuth(req(), storeA);
    expect(auth.scopes).toEqual([]);
  });
});
