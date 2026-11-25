import {
  buildServerCard,
  discoveryResponse,
  loadDiscoveryCtx,
  notFoundResponse,
} from '../../../lib/agent-mcp-discovery';

/** `/.well-known/mcp.json` - same card as `/.well-known/mcp/server-card.json`, for clients that probe the flat path. */
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await loadDiscoveryCtx();
  if (!ctx) return notFoundResponse();
  return discoveryResponse(
    JSON.stringify(buildServerCard(ctx), null, 2),
    'application/json; charset=utf-8',
    ctx.viaCookie
  );
}
