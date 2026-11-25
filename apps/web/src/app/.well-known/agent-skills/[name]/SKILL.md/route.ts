import {
  discoveryResponse,
  loadDiscoveryCtx,
  notFoundResponse,
  skillsFor,
} from '../../../../../lib/agent-mcp-discovery';

/** `/.well-known/agent-skills/<name>/SKILL.md` - generated from the tool manifest, never hand-written. */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const d = await loadDiscoveryCtx();
  if (!d) return notFoundResponse();
  const { name } = await ctx.params;
  const skill = skillsFor(d).find(s => s.name === name);
  if (!skill) return notFoundResponse();
  return discoveryResponse(skill.body, 'text/markdown; charset=utf-8', d.viaCookie);
}
