import { API_URL } from './api';
import {
  resolveAgentStore,
  resolvedViaCookie,
  storefrontBaseUrl,
  type AgentStore,
} from './agent-store-resolver';
import {
  renderStoreMcpSkills,
  STORE_MCP_READ_TOOL_NAMES,
  STORE_MCP_WRITE_TOOL_NAMES,
  type StoreMcpSkill,
} from '@ebda/shared';

/**
 * Shared plumbing for the MCP discovery documents (`/.well-known/mcp/server-card.json`,
 * `/.well-known/mcp.json`, `/.well-known/agent-skills/*`). Mirrors `acp.json`'s posture exactly:
 * fail closed with a byte-identical 404, host-resolved store, public info only.
 *
 * STALENESS CLASS: BOUNDED-stale. The `agent_checkout` gate is permission state; a 5 minute TTL
 * (`max-age=300, s-maxage=300`) is the documented residual window in which a store that just
 * switched agent checkout off still advertises it - the MCP endpoint itself re-checks the gate on
 * every call and 404s, so a stale document can mislead an agent but never grant it anything.
 * Keyed by Host alone (middleware sets `x-store-domain`), so the URL fully keys the shared cache;
 * the `viaCookie -> private` branch is the same retired second line of defence acp.json keeps.
 */

export const notFoundResponse = () =>
  new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

export interface DiscoveryCtx {
  store: AgentStore;
  base: string;
  mcpUrl: string;
  viaCookie: boolean;
}

/** `null` = 404: unknown host, inactive store, platform host, or `agent_checkout` off (all indistinguishable). */
export async function loadDiscoveryCtx(): Promise<DiscoveryCtx | null> {
  const store = await resolveAgentStore();
  if (!store) return null;
  if (!store.enabledFeatures?.includes('agent_checkout')) return null;
  return {
    store,
    base: storefrontBaseUrl(store),
    mcpUrl: `${API_URL}/mcp/${store.slug}`,
    viaCookie: await resolvedViaCookie(),
  };
}

export function discoveryResponse(body: string, contentType: string, viaCookie: boolean): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': viaCookie ? 'private, max-age=300' : 'public, max-age=300, s-maxage=300',
      ...(viaCookie ? {} : { Vary: 'Cookie' }),
    },
  });
}

export function skillsFor(ctx: DiscoveryCtx): StoreMcpSkill[] {
  return renderStoreMcpSkills({
    storeName: ctx.store.name,
    storeNameAr: ctx.store.nameAr,
    mcpUrl: ctx.mcpUrl,
  });
}

/**
 * MCP server card (SEP-1649 shape). Public info only: no contact, no key, and writes are ALWAYS
 * advertised as credentialed - never branch on `agent_checkout_open_writes` (see acp.json).
 */
export function buildServerCard(ctx: DiscoveryCtx) {
  const { store, base, mcpUrl } = ctx;
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server-card.schema.json',
    name: `ebda-store-${store.slug}`,
    title: store.name,
    title_localized: store.nameAr ? { ar: store.nameAr } : undefined,
    description: `Shop ${store.name}: search products, build a cart and place an order.`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: mcpUrl }],
    authentication: {
      read: 'none',
      write: 'api_key',
      write_header: 'x-agent-key',
      write_instructions:
        'Ask the store to issue an agent key. Without it the read tools still work and write tools return an error explaining this.',
    },
    capabilities: { tools: { read: STORE_MCP_READ_TOOL_NAMES, write: STORE_MCP_WRITE_TOOL_NAMES } },
    documents: {
      skills: `${base}/.well-known/agent-skills/index.json`,
      llms_txt: `${base}/llms.txt`,
      acp: `${base}/.well-known/acp.json`,
    },
  };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Agent Skills discovery index (`/.well-known/agent-skills/index.json`). */
export async function buildSkillsIndex(ctx: DiscoveryCtx) {
  const skills = await Promise.all(
    skillsFor(ctx).map(async s => ({
      name: s.name,
      type: 'skill-md',
      description: s.description,
      url: `${ctx.base}/.well-known/agent-skills/${s.name}/SKILL.md`,
      digest: `sha256:${await sha256Hex(s.body)}`,
    }))
  );
  return { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills };
}
