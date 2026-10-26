/**
 * Builder Phase 5: AI patch editing. `proposeBuilderPatch` asks the model for a structured patch
 * and applies it to a COPY of the saved document; `applyBuilderPatch` re-derives the result from
 * the ops on the server (the client never sends a document) and saves it as a DRAFT through the
 * normal `saveDraft` path, so a patch is never published, is undoable in history and passes the
 * same validation as a hand edit. Page documents hold no buyer data; the prompt gets only section
 * ids, setting keys and the current scalar values (`describeAiPatchContext`).
 */
import {
  aiPatchOpSchema,
  applyAiPatch,
  describeAiPatchContext,
  validateDefinitionSync,
  AI_PATCH_MAX_OPS,
  type AiPatchChange,
  type AiPatchOp,
  type AiPatchResult,
  type PageDefinition,
} from '@ebda/shared';
import { z } from 'zod';
import { AIService } from './ai.service';
import { getPageState, saveDraft, type ServiceResult } from './page-builder.service';

export interface BuilderPatchProposal {
  baseRev: number;
  summaryEn: string;
  summaryAr: string;
  /** Only the ops that applied: this is what the merchant approves and what `apply` replays. */
  ops: AiPatchOp[];
  changes: AiPatchChange[];
  rejected: AiPatchResult['rejected'];
  /** The page with the patch applied, for the canvas preview. Never saved by `propose`. */
  candidate: PageDefinition;
}

const notFound = {
  ok: false,
  status: 404,
  code: 'NOT_FOUND',
  message: 'Store not found',
} as const;

export async function proposeBuilderPatch(args: {
  storeId: string;
  pageKey: string;
  instruction: string;
}): Promise<ServiceResult<BuilderPatchProposal>> {
  const state = await getPageState(args.storeId, args.pageKey);
  if (!state) return notFound;
  const { patch } = await AIService.proposeBuilderPatch({
    storeId: args.storeId,
    instruction: args.instruction,
    page: describeAiPatchContext(state.definition),
  });
  const applied = applyAiPatch(state.definition, patch.ops);
  const dropped = new Set(applied.rejected.map(r => r.index));
  const ok = validateDefinitionSync(applied.doc);
  if (!ok.ok)
    return {
      ok: false,
      status: 422,
      code: 'AI_PATCH_INVALID',
      message: 'The proposed change does not produce a valid page.',
      errors: ok.errors,
    };
  return {
    ok: true,
    value: {
      baseRev: state.rev,
      summaryEn: patch.summaryEn,
      summaryAr: patch.summaryAr,
      ops: patch.ops.filter((_, i) => !dropped.has(i)),
      changes: applied.changes,
      rejected: applied.rejected,
      candidate: applied.doc,
    },
  };
}

const opsSchema = z.array(aiPatchOpSchema).max(AI_PATCH_MAX_OPS);

export async function applyBuilderPatch(args: {
  storeId: string;
  pageKey: string;
  baseRev: number;
  ops: unknown;
  userId: string | null;
}): Promise<ServiceResult<{ rev: number; changes: AiPatchChange[] }>> {
  const parsed = opsSchema.safeParse(args.ops);
  if (!parsed.success)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_PATCH',
      message: 'The patch is not valid.',
    };
  const state = await getPageState(args.storeId, args.pageKey);
  if (!state) return notFound;
  if (state.rev !== args.baseRev)
    return {
      ok: false,
      status: 409,
      code: 'REV_CONFLICT',
      message: `The page changed (now rev ${state.rev}); ask again.`,
      latest: state,
    };
  const applied = applyAiPatch(state.definition, parsed.data);
  if (applied.rejected.length > 0)
    return {
      ok: false,
      status: 409,
      code: 'PATCH_STALE',
      message: 'The page no longer matches this proposal; ask again.',
    };
  const saved = await saveDraft({
    storeId: args.storeId,
    pageKey: args.pageKey,
    baseRev: args.baseRev,
    definition: applied.doc,
    userId: args.userId,
  });
  if (!saved.ok) return saved;
  return { ok: true, value: { rev: saved.value.rev, changes: applied.changes } };
}
