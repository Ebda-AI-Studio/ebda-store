import { API_URL } from '../../../lib/api';
import {
  resolveAgentStore,
  resolvedViaCookie,
  storefrontBaseUrl,
} from '../../../lib/agent-store-resolver';

import { REGION, STORE_MCP_READ_TOOL_NAMES, STORE_MCP_WRITE_TOOL_NAMES } from '@ebda/shared';
/**
 * `/.well-known/acp.json` — Agentic Commerce Protocol discovery.
 *
 * ACP (OpenAI / Stripe / Meta) and UCP (Google / Shopify) both start the same
 * way: an agent that lands on a storefront looks for a well-known document
 * that says "yes, you can transact here, and this is how". Until now the ONLY
 * place this store's MCP endpoint was discoverable was inside `/llms.txt`,
 * which an agent has to think to read; a well-known path is the one an agent
 * checks by convention.
 *
 * This is a DISCOVERY document, not a new transaction surface. Every capability
 * it names already exists and is already enforced — it points at the MCP
 * endpoint (`apps/api`), the product feed, and the credential contract. Nothing
 * here grants anything.
 *
 * ## Served per store, on three hosts
 *
 *   demo-shop.example/.well-known/acp.json          → that merchant
 *   <slug>.ebda.app/.well-known/…      → that merchant
 *   ebda.app/.well-known/…             → 404 (the platform is not a shop)
 *
 * `resolveAgentStore()` owns that logic, shared with `/llms.txt` so the two
 * cannot disagree about which store a request belongs to.
 *
 * ## Fail closed
 *
 * A store without `agent_checkout` gets a 404, byte-identical to an unknown
 * store's — the same posture `mcp.routes.ts` takes, and for the same reason: a
 * discovery document that says "this store exists but will not sell to you" is
 * a capability leak with no upside for the agent.
 */

export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

export async function GET() {
  const store = await resolveAgentStore();
  if (!store) return notFound();

  // Fail closed. Same 404 as an unknown store — do not diverge these.
  if (!store.enabledFeatures?.includes('agent_checkout')) return notFound();

  const base = storefrontBaseUrl(store);
  const viaCookie = await resolvedViaCookie();

  const body = {
    // ACP is still a moving target; the version an agent sees is the one this
    // document was written against, not a guess at the newest.
    acp_version: '2026-01',
    merchant: {
      name: store.name,
      name_localized: store.nameAr ? { ar: store.nameAr } : undefined,
      description: store.description ?? undefined,
      url: base,
      contact: {
        email: store.email ?? undefined,
        phone: store.phone ?? undefined,
      },
    },
    // The currency a price in any of these surfaces is quoted in. Integer minor
    // units throughout — EGP prices are in piastres (1 EGP = 100 piastres), so an
    // agent that assumes 2 decimal places will be wrong by 10x on this platform.
    currency: store.currency ?? REGION.currency,
    capabilities: {
      catalog: true,
      cart: true,
      checkout: true,
      // Not advertised because it is not built: returns and refunds exist in
      // the dashboard but have no agent-facing tool. Saying `true` here would
      // be the discovery document promising something no tool can do.
      returns: false,
    },
    endpoints: {
      // The real transaction surface. Served by apps/api, so it is rooted at
      // the API origin, not at the storefront base.
      mcp: `${API_URL}/mcp/${store.slug}`,
      mcp_transport: 'streamable-http',
      product_feed: `${base}/feeds/products.json`,
      llms_txt: `${base}/llms.txt`,
      mcp_server_card: `${base}/.well-known/mcp/server-card.json`,
      agent_skills: `${base}/.well-known/agent-skills/index.json`,
    },
    authentication: {
      // Reads are anonymous by design — that is the whole strategic surface.
      // Writes are ALWAYS advertised as requiring a key, even for a store
      // with the `agent_checkout_open_writes` escape hatch on. This document
      // is public and unauthenticated, so branching this on the hatch would
      // publish, in machine-readable form, exactly which stores accept an
      // uncredentialed place_order — a scan of every merchant's acp.json
      // enumerates the open ones. An open store still accepts a write
      // request that omits the key (the MCP auth layer decides that, not
      // this document); it just isn't told apart from a credentialed one
      // here. Keep in step with `ucp`'s `auth` block and llms.txt's
      // `mcpWriteLine` (audit-followup: scoped-audit P2 on PR #1942).
      read: 'none',
      write: 'api_key',
      write_header: 'x-agent-key',
      write_instructions:
        'Ask the merchant (see merchant.contact) to issue an agent key. Without it the read tools still work and the write tools return an error explaining this.',
    },
    tools: {
      read: STORE_MCP_READ_TOOL_NAMES,
      write: STORE_MCP_WRITE_TOOL_NAMES,
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short TTL: the feature gate is permission state, and a stale answer
      // tells an agent it may transact when it may not (or the reverse). Five
      // minutes bounds the window without a per-request DB read.
      //
      // Shared-cacheable because this path is resolved ONLY from the request
      // Host (`<slug>.ebda.app` or the custom domain) — middleware sets
      // `x-store-domain` from it and no cookie or path ever names a store, so
      // the URL (host included) fully keys the answer at a shared cache. The
      // `viaCookie → private` branch below is a retired second line of defence
      // (see resolvedViaCookie). `Vary: Cookie` covers a Vary-respecting cache.
      'Cache-Control': viaCookie ? 'private, max-age=300' : 'public, max-age=300, s-maxage=300',
      ...(viaCookie ? {} : { Vary: 'Cookie' }),
    },
  });
}
