/**
 * Runtime guard against placeholder/degenerate AI output reaching a
 * merchant-facing, store-facing field.
 *
 * Every bulk AI sweep (store FAQ, store HowTo, meta-AEO, llms.txt,
 * citation-copy, product FAQ — see call sites in
 * `lib/inngest/functions/bulk-ai-{aeo,geo,product-faqs}.ts`) writes its
 * Gemini output DIRECTLY to a live, store-facing column/table and busts the
 * public cache in the same step — there is no merchant draft/review gate on
 * this path (unlike the single-item "Draft with AI" routes, which return
 * the suggestion to the admin UI for the merchant to accept or edit). The
 * only check guarding those writes before this module existed was
 * "non-empty after trim()", which a degenerate Gemini response like "N/A",
 * "TBD", "..." or "[insert text here]" trivially satisfies — that content
 * then goes live on the storefront with zero human review.
 *
 * This module wraps the canonical, single definition of "placeholder text a
 * real generation should never emit" shared between:
 *   - the live bulk-sweep write paths (this import), and
 *   - the offline AI-output eval harness (`lib/ai/eval/helpers.ts`
 *     re-exports `isPlaceholder` from here) so the two can't drift apart.
 *
 * Fix choice (2026-10): SKIP the item (same bucket as the existing
 * "missing required field" skip, counted in the job's `skipped` total) —
 * never block the whole sweep. A single bad FAQ/description out of a batch
 * of 8 is not a reason to fail every other, genuinely-good item; omitting
 * the bad one and leaving the slot empty (so the merchant notices and can
 * re-run or author it by hand) is strictly better than publishing garbage.
 */

import { isPlaceholderCopy } from '@ebda/shared';

/**
 * Pattern set lives in `@ebda/shared` (`builder/placeholder-copy.ts`) so the
 * editor PUBLISH gate and these AI write paths share one definition. Here,
 * unlike at publish, a missing/blank value is also unacceptable AI output.
 */
export function isPlaceholderText(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  if (!v.trim()) return true;
  return isPlaceholderCopy(v);
}
