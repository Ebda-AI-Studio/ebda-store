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
import { describeCatalogueForPrompt, loadBuilderAiCatalogue } from './builder-ai-context.service';

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
  /** The editor's current canvas width, so "fix the mobile view" means the phone. */
  viewport?: 'desktop' | 'tablet' | 'mobile';
  /** The admin language the merchant is writing in; new copy the model fills in follows it. */
  locale?: 'ar' | 'en';
}): Promise<ServiceResult<BuilderPatchProposal>> {
  const state = await getPageState(args.storeId, args.pageKey);
  if (!state) return notFound;
  const catalogue = await loadBuilderAiCatalogue(args.storeId);
  if (!catalogue) return notFound;
  const { patch } = await AIService.proposeBuilderPatch({
    storeId: args.storeId,
    instruction: args.instruction,
    page: {
      ...describeAiPatchContext(state.definition),
      viewport: args.viewport ?? 'desktop',
      locale: args.locale ?? 'ar',
      ...describeCatalogueForPrompt(catalogue),
    },
  });
  // References are checked against THIS store's own catalogue, never against what the model says exists.
  const applied = applyAiPatch(state.definition, patch.ops, catalogue.allow);
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
