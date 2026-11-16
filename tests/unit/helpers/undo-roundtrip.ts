/**
 * Engine-level undo round trip for ANY change tool (review of #790/#802/#803: every create tool's undo came back "stale" because the etag stored after the
 * create was not the one the inverse tool's preview computes). It runs the REAL engine journal (createPreviewRecord -> apply or confirm -> undoApplied) with
 * an in-memory store of the journal and the given tools, and returns the final undo status. A tool test calls it with mocked services, then asserts `undone`.
 */
import {
  applyPreview,
  confirmApproval,
  createPreviewRecord,
  issueApproval,
  undoApplied,
  type SmartLayerAdapter,
  type ToolSpec,
  type TurnCtx,
} from '@ebda/shared/smart-layer';
import { memoryStorage } from '../../../packages/shared/src/foundation/smart-layer/eval/memory-storage';
import { storeRegistry } from '@api/smart-layer/registry';

export const roundTripCtx = (over: Partial<TurnCtx> = {}): TurnCtx => ({
  product: 'store',
  storeId: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  role: 'store_admin',
  locale: 'en',
  now: 1_800_000_000_000,
  conversationId: 'c',
  releaseId: 'r',
  ...over,
});

export function journalAdapter(
  tools: ToolSpec[]
): SmartLayerAdapter & { storage: ReturnType<typeof memoryStorage> } {
  const storage = memoryStorage();
  return {
    product: 'store',
    registry: () => storeRegistry(),
    tools: () => tools,
    controls: async () => ({
      mode: 'act',
      killGlobal: false,
      killProduct: false,
      killedTools: new Set<string>(),
      shadow: false,
    }),
    storage,
  } as unknown as SmartLayerAdapter & { storage: ReturnType<typeof memoryStorage> };
}

/** Preview -> apply (a confirm-class card goes through issueApproval + confirmApproval) -> undo. Returns each step's status. */
export async function applyThenUndo(
  tools: ToolSpec[],
  tool: ToolSpec,
  args: unknown,
  ctx: TurnCtx = roundTripCtx()
): Promise<{ applied: string; undo: string; card?: unknown }> {
  const a = journalAdapter(tools);
  const { record } = await createPreviewRecord(a, ctx, tool, args, 'turn');
  let appliedId: string | undefined;
  if (record.policy === 'confirm') {
    let token = '';
    const issued = await issueApproval(a, ctx, record);
    token = issued.token;
    const r = await confirmApproval(a, ctx, issued.approvalId, token);
    if (r.status !== 'applied') return { applied: r.status, undo: 'not_attempted' };
    appliedId = r.appliedId;
  } else {
    const r = await applyPreview(a, ctx, record.id);
    if (r.status !== 'applied') return { applied: r.status, undo: 'not_attempted' };
    appliedId = r.appliedId;
  }
  const u = await undoApplied(a, ctx, appliedId);
  return { applied: 'applied', undo: u.status, ...('card' in u ? { card: u.card } : {}) };
}
