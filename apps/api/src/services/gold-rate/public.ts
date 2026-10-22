/**
 * What the STOREFRONT may know about a gold piece (Ruling B5-13): karat, weight, today's rate per gram,
 * when it was recorded and the store's max age, and (only when the merchant turned it on) the metal /
 * making split. NEVER the margin, the making-charge settings, the rate row id or where the rate came from
 * (`publicGoldPricingSchema` has no such key and the output is parsed through it). The rate reads are
 * never cached here; the callers ride the product / cart caches, which every rate write purges.
 */
import { Prisma } from '@ebda/database';
import {
  computeGoldUnitPrice,
  publicGoldPricingSchema,
  type GoldKarat,
  type PublicGoldPricing,
} from '@ebda/shared';
import { goldQuoteKey, lineGoldSpec, loadCurrentRates, loadSettings } from './gate';

type Tx = Prisma.TransactionClient;

const specSelect = {
  pricingMode: true,
  goldKarat: true,
  goldWeightMg: true,
  makingChargeType: true,
  makingChargeValue: true,
  goldMarginBps: true,
} as const;

/**
 * Public gold pricing for lines `{ productId, variantId }`, keyed by `goldQuoteKey`. A fixed-price line,
 * or a gold line whose karat has no rate yet, is simply absent (the storefront then shows nothing).
 */
export async function publicGoldPricingForLines(
  db: Tx,
  storeId: string,
  lines: ReadonlyArray<{ productId: string; variantId: string | null }>
): Promise<Map<string, PublicGoldPricing>> {
  const out = new Map<string, PublicGoldPricing>();
  if (lines.length === 0) return out;
  const productIds = [...new Set(lines.map(l => l.productId))];
  const products = await db.product.findMany({
    where: { id: { in: productIds }, storeId },
    select: {
      id: true,
      ...specSelect,
      variants: { select: { id: true, ...specSelect } },
    },
  });
  const pById = new Map(products.map(p => [p.id, p]));
  const wanted: Array<{ key: string; spec: NonNullable<ReturnType<typeof lineGoldSpec>> }> = [];
  for (const l of lines) {
    const p = pById.get(l.productId);
    if (!p) continue;
    const v = l.variantId ? (p.variants.find(x => x.id === l.variantId) ?? null) : null;
    if (p.pricingMode !== 'gold_rate' && v?.pricingMode !== 'gold_rate') continue;
    const spec = lineGoldSpec(p, v);
    if (spec) wanted.push({ key: goldQuoteKey(l.productId, l.variantId), spec });
  }
  if (wanted.length === 0) return out;
  const [settings, rates] = await Promise.all([
    loadSettings(db, storeId),
    loadCurrentRates(db, storeId, [...new Set(wanted.map(w => w.spec.karat as GoldKarat))]),
  ]);
  for (const { key, spec } of wanted) {
    const rate = rates.get(spec.karat);
    if (!rate) continue;
    const split = settings.showBreakdown
      ? computeGoldUnitPrice(spec, rate.ratePerGram, settings.roundingStep)
      : null;
    out.set(
      key,
      publicGoldPricingSchema.parse({
        karat: spec.karat,
        weightMg: spec.weightMg,
        ratePerGram: rate.ratePerGram,
        rateAppliedAt: rate.appliedAt.toISOString(),
        maxAgeMinutes: settings.maxAgeMinutes,
        ...(split
          ? { breakdown: { metalValue: split.metalValue, makingValue: split.makingValue } }
          : {}),
      })
    );
  }
  return out;
}

/** The PDP fields: the product's own line and one entry per variant that is priced by gold. */
export async function publicGoldFields(
  db: Tx,
  storeId: string,
  product: { id: string; variants?: ReadonlyArray<{ id: string }> }
): Promise<{
  goldPricing: PublicGoldPricing | null;
  variantGoldPricing?: Record<string, PublicGoldPricing>;
}> {
  const lines = [
    { productId: product.id, variantId: null as string | null },
    ...(product.variants ?? []).map(v => ({
      productId: product.id,
      variantId: v.id as string | null,
    })),
  ];
  const map = await publicGoldPricingForLines(db, storeId, lines);
  const variantGoldPricing: Record<string, PublicGoldPricing> = {};
  for (const v of product.variants ?? []) {
    const g = map.get(goldQuoteKey(product.id, v.id));
    if (g) variantGoldPricing[v.id] = g;
  }
  return {
    goldPricing: map.get(goldQuoteKey(product.id, null)) ?? null,
    ...(Object.keys(variantGoldPricing).length > 0 ? { variantGoldPricing } : {}),
  };
}
