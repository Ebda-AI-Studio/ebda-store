/**
 * Quota for the Store assistant. A turn needs the merchant's AI switch on and platform AI headroom (`assertAiQuota`: the per-store daily slice and the
 * global caps) and stays inside the free cap of BUDGET.freeTurnsPerStorePerDay per store per rolling day (the journal's sliding-window counter).
 * Usage is recorded under the feature label `assistant` in the same `ai_usage` meter as every other AI feature. Heavy jobs (template writer, bulk;
 * later phases) will spend plan AI credits and show the cost first; Phase A has none, so a request for heavy credits is refused.
 */
import { BUDGET, type SmartLayerAdapter, type SmartLayerStorage } from '@ebda/shared/smart-layer';
import { assertAiQuota } from '../lib/ai-quota';
import { recordUsage } from '../services/ai.service';

const DAY = 86_400_000;

export function storeQuota(
  storage: Pick<SmartLayerStorage, 'bump'>,
  deps: { assert?: typeof assertAiQuota; record?: typeof recordUsage } = {}
): SmartLayerAdapter['quota'] {
  const assert = deps.assert ?? assertAiQuota;
  const record = deps.record ?? recordUsage;
  return {
    async assertTurn(ctx, heavyCredits) {
      if (heavyCredits && heavyCredits > 0) throw new Error('heavy_not_available');
      await assert({ storeId: ctx.storeId });
      if (
        (await storage.bump(`free:${ctx.storeId}`, DAY, ctx.now)) > BUDGET.freeTurnsPerStorePerDay
      )
        throw new Error('free_cap');
    },
    async record(ctx, u) {
      await record(ctx.storeId, 'assistant', u.inputTokens, u.outputTokens, false, {
        model: u.model,
      });
    },
  };
}
