import {
  buildSkillsIndex,
  discoveryResponse,
  loadDiscoveryCtx,
  notFoundResponse,
} from '../../../../lib/agent-mcp-discovery';

/** `/.well-known/agent-skills/index.json` - Agent Skills discovery index. Policy + cache class: lib/agent-mcp-discovery.ts. */
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await loadDiscoveryCtx();
  if (!ctx) return notFoundResponse();
  return discoveryResponse(
    JSON.stringify(await buildSkillsIndex(ctx), null, 2),
    'application/json; charset=utf-8',
    ctx.viaCookie
  );
}
