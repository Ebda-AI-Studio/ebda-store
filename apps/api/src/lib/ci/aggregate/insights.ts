/**
 * CI-2 insights (plan 3.2, Ruling CI-9): rule-based findings over the cross-store cohort. The input is
 * the published cohort only (k-anonymous cells, no store, order or buyer identifier) and goes through
 * `assertAggregateOnly` first; a finding that fails it is a thrown error and an alert, never a trimmed row.
 * No model is called today: `model: 'rules-v1'`. If one is added, it reads these same findings behind
 * the same guard (Workers AI first).
 *
 * A finding only RECORDS. Nothing here changes a default: a super-admin accepts or dismisses it.
 */
import { ANY, splitKey, type Metric } from './cells';
import type { Cohort, CohortCell, PublishedCell } from './run';
import { assertAggregateOnly } from './guard';
import { wilsonLower, wilsonUpper } from './stats';

export interface InsightDraft {
  dedupeKey: string;
  metric: Metric;
  cohort: string;
  finding: string;
  findingAr: string;
  evidence: {
    n: number;
    stores: number;
    rate: number;
    baselineRate: number;
    bound: number;
    asOf: string;
  };
}

/** Delivery slower than this multiple of the carrier's own platform mean is worth a look. */
export const SLOW_DELIVERY_FACTOR = 1.5;

const live = (c: PublishedCell | undefined): c is CohortCell => !!c && !('suppressed' in c);
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function cut(cohort: Cohort, metric: Metric, key: string) {
  const c = cohort.metrics[metric][key];
  return live(c) ? c : undefined;
}

export function generateInsights(cohort: Cohort): InsightDraft[] {
  assertAggregateOnly(cohort);
  const out: InsightDraft[] = [];
  const push = (d: Omit<InsightDraft, 'dedupeKey'>, kind: string) => {
    const draft = { ...d, dedupeKey: `${d.metric}:${kind}:${d.cohort}`.slice(0, 160) };
    assertAggregateOnly(draft);
    out.push(draft);
  };

  // Returns: a carrier x area cell whose lower bound clears the carrier's own platform rate.
  for (const [key, c] of Object.entries(cohort.metrics.return_rate)) {
    if (!live(c)) continue;
    const [carrier, area] = splitKey(key) as [string, string];
    if (area === ANY) continue;
    const base = cut(cohort, 'return_rate', `${carrier}|${ANY}`);
    if (!base) continue;
    const baseRate = base.hit / base.n;
    const lb = wilsonLower(c.hit, c.n);
    if (lb > baseRate) {
      const who = carrier === ANY ? 'all carriers' : carrier;
      push(
        {
          metric: 'return_rate',
          cohort: key,
          finding: `Returns are elevated for ${who} in ${area}: ${pct(c.hit / c.n)} of ${c.n} outcomes (platform ${pct(baseRate)}).`,
          findingAr: `المرتجعات مرتفعة مع ${carrier === ANY ? 'كل شركات الشحن' : carrier} في ${area}: ${pct(c.hit / c.n)} من ${c.n} طلب (المتوسط ${pct(baseRate)}).`,
          evidence: {
            n: c.n,
            stores: c.stores,
            rate: round3(c.hit / c.n),
            baselineRate: round3(baseRate),
            bound: round3(lb),
            asOf: cohort.asOf,
          },
        },
        'elevated'
      );
    }
  }

  // Delivery speed: mean hours well above the carrier's platform mean.
  for (const [key, c] of Object.entries(cohort.metrics.delivery_hours)) {
    if (!live(c)) continue;
    const [carrier, area] = splitKey(key) as [string, string];
    if (area === ANY || carrier === ANY) continue;
    const base = cut(cohort, 'delivery_hours', `${carrier}|${ANY}`);
    if (!base) continue;
    const mean = c.sum / c.n;
    const baseMean = base.sum / base.n;
    if (baseMean > 0 && mean > baseMean * SLOW_DELIVERY_FACTOR) {
      push(
        {
          metric: 'delivery_hours',
          cohort: key,
          finding: `${carrier} delivers slowly in ${area}: ${Math.round(mean)} h on average over ${c.n} deliveries (platform ${Math.round(baseMean)} h).`,
          findingAr: `${carrier} بطيء في ${area}: متوسط ${Math.round(mean)} ساعة على ${c.n} توصيلة (المتوسط ${Math.round(baseMean)} ساعة).`,
          evidence: {
            n: c.n,
            stores: c.stores,
            rate: round3(mean),
            baselineRate: round3(baseMean),
            bound: round3(baseMean * SLOW_DELIVERY_FACTOR),
            asOf: cohort.asOf,
          },
        },
        'slow'
      );
    }
  }

  // COD confirmation: an area whose upper bound is still under the platform rate.
  const codBase = cut(cohort, 'cod_confirmation', ANY);
  if (codBase) {
    const baseRate = codBase.hit / codBase.n;
    for (const [key, c] of Object.entries(cohort.metrics.cod_confirmation)) {
      if (!live(c) || key === ANY) continue;
      const ub = wilsonUpper(c.hit, c.n);
      if (ub < baseRate) {
        push(
          {
            metric: 'cod_confirmation',
            cohort: key,
            finding: `COD confirmation is low in ${key}: ${pct(c.hit / c.n)} of ${c.n} orders (platform ${pct(baseRate)}).`,
            findingAr: `تأكيد الدفع عند الاستلام ضعيف في ${key}: ${pct(c.hit / c.n)} من ${c.n} طلب (المتوسط ${pct(baseRate)}).`,
            evidence: {
              n: c.n,
              stores: c.stores,
              rate: round3(c.hit / c.n),
              baselineRate: round3(baseRate),
              bound: round3(ub),
              asOf: cohort.asOf,
            },
          },
          'low'
        );
      }
    }
  }

  // COD amount: a bucket whose return rate clears the overall COD return rate.
  const amtBase = cut(cohort, 'cod_return_by_amount', ANY);
  if (amtBase) {
    const baseRate = amtBase.hit / amtBase.n;
    for (const [key, c] of Object.entries(cohort.metrics.cod_return_by_amount)) {
      if (!live(c) || key === ANY) continue;
      const lb = wilsonLower(c.hit, c.n);
      if (lb > baseRate) {
        push(
          {
            metric: 'cod_return_by_amount',
            cohort: key,
            finding: `COD orders in amount band ${key} return more: ${pct(c.hit / c.n)} of ${c.n} (all COD ${pct(baseRate)}).`,
            findingAr: `طلبات الدفع عند الاستلام في شريحة المبلغ ${key} ترجع أكتر: ${pct(c.hit / c.n)} من ${c.n} (المتوسط ${pct(baseRate)}).`,
            evidence: {
              n: c.n,
              stores: c.stores,
              rate: round3(c.hit / c.n),
              baselineRate: round3(baseRate),
              bound: round3(lb),
              asOf: cohort.asOf,
            },
          },
          'elevated'
        );
      }
    }
  }
  return out;
}
