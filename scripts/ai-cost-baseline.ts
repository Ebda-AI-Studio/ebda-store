/**
 * Regenerate apps/api/src/lib/ai/cost/cost-baseline.json from the current prompt
 * builders. Run after an INTENTIONAL prompt change so the cost gate's baseline
 * reflects the new size: `npx tsx scripts/ai-cost-baseline.ts`. Commit the diff
 * in the same PR — the change is then visible + reviewable (snapshot-style).
 */
import { writeFileSync } from 'node:fs';
import { AI_COST_FEATURES } from '../apps/api/src/lib/ai/cost/features';
import { estimateFeatureCost } from '../apps/api/src/lib/ai/cost/cost';

const baseline: Record<string, number> = {};
for (const f of AI_COST_FEATURES) {
  baseline[f.feature] = Number(estimateFeatureCost(f).usdPerDay.toFixed(6));
}
const out = new URL('../apps/api/src/lib/ai/cost/cost-baseline.json', import.meta.url);
writeFileSync(out, JSON.stringify(baseline, null, 2) + '\n');
console.log('wrote cost-baseline.json:', baseline);
