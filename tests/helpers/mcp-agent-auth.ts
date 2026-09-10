/**
 * Test doubles for the MCP tool-handler `extra` argument.
 *
 * The MCP SDK hands every tool handler an `extra` object carrying
 * `authInfo` — the value `mcp.routes.ts` put on `req.auth`. Unit tests that
 * drive a tool handler directly (rather than over the real transport) have to
 * supply it themselves, and a WRITE tool refuses without the `agent:write`
 * scope.
 *
 * Deliberately built from the real constants so a rename of the scope, or of
 * the context fields an audit row reads, breaks the helper rather than
 * silently producing an `extra` that authorises nothing.
 */
import { AGENT_WRITE_SCOPE, type McpAgentContext } from '../../apps/api/src/mcp/agent-auth';

/** `extra` for a request that presented a valid per-store agent credential. */
export function authorizedAgentExtra(overrides: Partial<McpAgentContext> = {}) {
  const context: McpAgentContext = {
    storeSlug: 'demo',
    ip: '203.0.113.9',
    userAgent: 'test-agent/1.0',
    requestId: 'req-test',
    credential: 'valid',
    grant: 'credential',
    ...overrides,
  };
  return {
    authInfo: {
      token: 'fingerprint-only',
      clientId: 'store:store-1',
      scopes: [AGENT_WRITE_SCOPE],
      extra: context,
    },
  };
}

/** `extra` for an anonymous request — no credential, no write scope. */
export function anonymousAgentExtra(overrides: Partial<McpAgentContext> = {}) {
  const context: McpAgentContext = {
    storeSlug: 'demo',
    ip: '203.0.113.9',
    userAgent: 'test-agent/1.0',
    requestId: 'req-test',
    credential: 'none',
    grant: 'denied',
    ...overrides,
  };
  return {
    authInfo: { token: '', clientId: 'anonymous', scopes: [] as string[], extra: context },
  };
}
