/**
 * #1643 — the write gate is opt-in per handler. `MCP_WRITE_TOOLS` only feeds
 * the log classifier; enforcement is a manual `assertAgentWrite(...)` inside
 * each write handler. A new mutating tool registered without that line would
 * ship unauthenticated, and `classifyToolCall` would just label it `unknown`.
 *
 * This binds the two structurally, against the REAL server factory:
 *  (a) every tool `buildStoreMcpServer` registers is classified — the
 *      registered set equals MCP_READ_TOOLS ∪ MCP_WRITE_TOOLS, so an
 *      unclassified new tool fails CI;
 *  (b) every tool in MCP_WRITE_TOOLS, driven with an anonymous request, is
 *      refused with AGENT_CREDENTIAL_REQUIRED before it touches anything.
 */
import { describe, it, expect, vi } from 'vitest';

// Any database access means a write handler got past the gate: fail loudly.
const { dbTouched } = vi.hoisted(() => {
  const dbTouched = () => {
    throw new Error('DB_TOUCHED_BEFORE_WRITE_GATE');
  };
  return { dbTouched };
});

vi.mock('@force/database', async importOriginal => {
  const model = new Proxy({}, { get: () => dbTouched });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    prisma: new Proxy({}, { get: () => model }),
    runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
    withTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  };
});
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { buildStoreMcpServer } from '@api/mcp/store-mcp-server';
import { MCP_READ_TOOLS, MCP_WRITE_TOOLS } from '@api/mcp/agent-auth';

const store = { id: 'store-a', name: 'Store A', slug: 'store-a', currency: 'KWD', domain: null };

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
const registered = () =>
  (buildStoreMcpServer(store) as unknown as { _registeredTools: Registered })._registeredTools;

describe('#1643 every registered MCP tool is classified', () => {
  it('registered tools == MCP_READ_TOOLS ∪ MCP_WRITE_TOOLS', () => {
    const names = Object.keys(registered()).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].sort());
  });

  it('no tool is classified as both a read and a write', () => {
    for (const name of MCP_WRITE_TOOLS) expect(MCP_READ_TOOLS.has(name)).toBe(false);
  });
});

describe('#1643 every write tool refuses an anonymous caller', () => {
  it.each([...MCP_WRITE_TOOLS])(
    '%s throws AGENT_CREDENTIAL_REQUIRED without a credential',
    async name => {
      const tool = registered()[name];
      expect(tool, `${name} is in MCP_WRITE_TOOLS but not registered`).toBeTruthy();

      const anonymous = { authInfo: { token: '', clientId: 'anonymous', scopes: [] } };
      await expect(tool.handler({}, anonymous)).rejects.toMatchObject({
        code: 'AGENT_CREDENTIAL_REQUIRED',
      });
    }
  );
});
