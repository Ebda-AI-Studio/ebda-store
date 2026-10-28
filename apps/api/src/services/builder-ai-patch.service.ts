/**
 * Builder Phase 5: AI patch editing. `proposeBuilderPatch` asks the model for a structured patch
 * and applies it to a COPY of the saved document; nothing is saved here. The editor puts the returned
 * candidate into its own undo history and saves it as a DRAFT through the normal autosave path
 * (`saveDraft`: rev-checked, fully validated, never published), exactly like a hand edit. Page documents hold no buyer data; the prompt gets only section
 * ids, setting keys and the current scalar values (`describeAiPatchContext`).
 */
import {
  applyAiPatch,
  describeAiPatchContext,
  validateDefinitionSync,
  type AiPatchChange,
  type AiPatchOp,
  type AiPatchResult,
  type PageDefinition,
} from '@ebda/shared';
import { AIService } from './ai.service';
import { getPageState, type ServiceResult } from './page-builder.service';

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
