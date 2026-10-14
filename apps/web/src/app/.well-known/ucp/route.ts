import { API_URL } from '../../../lib/api';
import {
  resolveAgentStore,
  resolvedViaCookie,
  storefrontBaseUrl,
} from '../../../lib/agent-store-resolver';

import { REGION, minorUnitsPerMajor } from '@ebda/shared';
/**
 * `/.well-known/ucp` — Universal Commerce Protocol discovery.
 *
 * The sibling of `/.well-known/acp.json`. UCP (Google / Shopify) and ACP
 * (OpenAI / Stripe / Meta) are two vendor camps asking the same question, and
 * both treat MCP as a first-class transport — so both documents point at the
 * SAME endpoint with the same credential contract. They differ only in shape.
 *
 * Written as its own file rather than a shared renderer with a format flag:
 * these are third-party specs that will drift apart, and a shared renderer
 * would mean every future ACP field needing a "not for UCP" condition. What IS
 * shared is the part that must never disagree — store resolution, the feature
 * gate, and the credential contract.
 *
 * Note the path has no extension: UCP's discovery path is `/.well-known/ucp`,
 * not `ucp.json`. Do not "fix" it to match its sibling.
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

  // Fail closed, identical to acp.json — a prober must not be able to tell
  // "no such store" from "store exists, agent checkout off" on either path.
  if (!store.enabledFeatures?.includes('agent_checkout')) return notFound();

  const base = storefrontBaseUrl(store);
  const viaCookie = await resolvedViaCookie();

  const body = {
    ucp_version: '2026-01',
    seller: {
      name: store.name,
      url: base,
      support: {
        email: store.email ?? undefined,
        phone: store.phone ?? undefined,
      },
    },
    // Integer MINOR units everywhere on this platform (EGP: 1 EGP = 100 piastres,
    // 2 decimals). The scale is stated explicitly per currency because a wrong
    // assumption here is a mispriced order, not a display bug.
    pricing: {
      currency: store.currency ?? REGION.currency,
      amounts: 'integer-minor-units',
      minor_units_per_major: minorUnitsPerMajor(store.currency ?? REGION.currency),
    },
    transports: [
      {
        type: 'mcp',
        url: `${API_URL}/mcp/${store.slug}`,
        transport: 'streamable-http',
        // Reads anonymous, writes ALWAYS advertised as credentialed — even
        // for a store with the agent_checkout_open_writes escape hatch on.
        // This document is public, so branching on the hatch would publish
        // which stores accept an uncredentialed place_order; an open store
        // still accepts a keyless write, it just isn't distinguishable here.
        // Keep in step with acp.json's `authentication` block and llms.txt
        // (audit-followup: scoped-audit P2 on PR #1942).
        auth: { read: 'none', write: 'api_key', header: 'x-agent-key' },
      },
    ],
    catalog: {
      feed: `${base}/feeds/products.json`,
      format: 'json',
    },
    documents: {
      llms_txt: `${base}/llms.txt`,
      acp: `${base}/.well-known/acp.json`,
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // See acp.json: resolved only from the request Host (`<slug>.ebda.app`
      // or custom domain), so the URL keys the answer. The `viaCookie →
      // private` branch is a retired second line of defence.
      'Cache-Control': viaCookie ? 'private, max-age=300' : 'public, max-age=300, s-maxage=300',
      ...(viaCookie ? {} : { Vary: 'Cookie' }),
    },
  });
}
