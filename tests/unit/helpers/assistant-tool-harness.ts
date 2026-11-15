/** Shared seams for the assistant change-tool tests (plan 4 B6): a turn context and the three calls every tool test makes. */
import type { AppliedResult, PreviewDraft, ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';

export const ctxOf = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 's1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 0,
  conversationId: 'c1',
  releaseId: 'r1',
});

export function toolNamed(tools: ToolSpec[], name: string): ToolSpec {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} is not registered`);
  return t;
}

export const previewOf = (t: ToolSpec, args: unknown, role?: string): Promise<PreviewDraft> =>
  t.preview!(ctxOf(role), args as never);

export async function applyOf(
  t: ToolSpec,
  args: unknown,
  role?: string
): Promise<{ draft: PreviewDraft; applied: AppliedResult }> {
  const draft = await previewOf(t, args); // the card is previewed by an owner; `role` is who presses Apply
  const applied = await t.apply!(ctxOf(role), args as never, draft);
  return { draft, applied };
}
