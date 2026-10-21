/**
 * Client-side check of a tier draft BEFORE it is sent (B2B Task 7). The server stays the authority (the same
 * `validateTierWrite` runs there against the stored tiers); this only spares the merchant a round trip for the obvious
 * mistakes and powers the live margin hint.
 */
import { tryToMinor, validateTierWrite, type TierInput, type TierErrorCode } from '@ebda/shared';

export interface TierDraft {
  variantId: string | null;
  groupId: string | null;
  /** Raw input strings. */
  minQty: string;
  price: string;
}

export type DraftProblem = 'MIN_QTY' | 'PRICE' | TierErrorCode;

export interface DraftResult {
  tier: TierInput | null;
  /** First blocking problem, or null when the draft can be sent. */
  problem: DraftProblem | null;
  /** Non-blocking: 'TIER_BELOW_COST' | 'TIER_BELOW_MOQ'. */
  warnings: string[];
  /** Margin vs the cost price in percent (rounded), or null when there is no cost price / no price yet. */
  marginPercent: number | null;
}

export function checkTierDraft(
  draft: TierDraft,
  ctx: {
    existing: readonly TierInput[];
    productPriceMinor: number;
    variantPriceMinor?: number | null;
    costPriceMinor?: number | null;
    moq?: number | null;
  }
): DraftResult {
  const minQty = Number(draft.minQty);
  if (!Number.isInteger(minQty) || minQty < 2) {
    return { tier: null, problem: 'MIN_QTY', warnings: [], marginPercent: null };
  }
  const priceMinor = tryToMinor(draft.price.trim() === '' ? NaN : draft.price);
  if (priceMinor === null || priceMinor < 0) {
    return { tier: null, problem: 'PRICE', warnings: [], marginPercent: null };
  }
  const tier: TierInput = {
    variantId: draft.variantId,
    groupId: draft.groupId,
    minQty,
    priceMinor,
  };
  const r = validateTierWrite({
    tier,
    existing: ctx.existing,
    productPriceMinor: ctx.productPriceMinor,
    variantPriceMinor: ctx.variantPriceMinor,
    costPriceMinor: ctx.costPriceMinor,
    moq: ctx.moq,
  });
  const margin =
    ctx.costPriceMinor != null && priceMinor > 0
      ? Math.round(((priceMinor - ctx.costPriceMinor) / priceMinor) * 100)
      : null;
  return {
    tier,
    problem: r.errors[0]?.code ?? null,
    warnings: r.warnings.map(w => w.code),
    marginPercent: margin,
  };
}
