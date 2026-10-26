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
  mgToGramsString,
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

const PUBLIC_SNAPSHOT_KEYS = [
  'karat',
  'weightMg',
  'ratePerGram',
  'rateAppliedAt',
  'unitPrice',
] as const;

/**
 * An order as the CUSTOMER may see it: each line's `goldSnapshot` cut down to what the shopper was
 * shown at checkout (karat, weight, rate, when, unit price), and the merchant-only `costPrice` removed.
 * The full snapshot holds the margin, the making charge and the rate row id; those stay with the
 * merchant (Ruling B5-13). Used by every customer-facing order read; the admin read is unfiltered.
 */
export function redactOrderForCustomer<T extends { items?: unknown }>(order: T): T {
  const items = (order.items ?? null) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(items)) return order;
  return {
    ...order,
    items: items.map(item => {
      const { costPrice: _cost, goldSnapshot, ...rest } = item;
      void _cost;
      if (goldSnapshot && typeof goldSnapshot === 'object') {
        const snap = goldSnapshot as Record<string, unknown>;
        return {
          ...rest,
          goldSnapshot: Object.fromEntries(PUBLIC_SNAPSHOT_KEYS.map(k => [k, snap[k]])),
        };
      }
      return { ...rest, goldSnapshot: goldSnapshot ?? null };
    }),
  };
}

/**
 * The one-line description of how a gold line was priced, for an invoice or a receipt: karat, weight
 * and the per-gram rate frozen on the line. Null when the line was not gold-priced. Never the margin.
 */
export function goldLineNote(
  snapshot: unknown,
  lang: 'ar' | 'en',
  money: (piastres: number) => string
): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const { karat, weightMg, ratePerGram } = s;
  if (typeof karat !== 'number' || typeof weightMg !== 'number' || typeof ratePerGram !== 'number')
    return null;
  const grams = mgToGramsString(weightMg);
  return lang === 'ar'
    ? `عيار ${String(karat)} · ${grams} جم · ${money(ratePerGram)} للجرام`
    : `${String(karat)} karat · ${grams} g · ${money(ratePerGram)} per gram`;
}

const GUEST_ORDER_FIELDS = [
  'id',
  'orderNumber',
  'status',
  'paymentStatus',
  'currency',
  'createdAt',
  'total',
  'subtotal',
  'shipping',
  'discount',
  'codFee',
  'tax',
  'taxIncludedInPrice',
  'walletAmount',
] as const;

const GUEST_ITEM_FIELDS = [
  'id',
  'productId',
  'variantId',
  'quantity',
  'price',
  'product',
  'variantName',
  'variantNameAr',
  'goldSnapshot',
  'bundleId',
  'bundleGroupId',
  'bundleName',
  'bundleNameAr',
] as const;

const pick = (src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
};

/**
 * A GUEST order for a viewer who does not hold its view token (SEC-15 / M-137): the order UUID alone
 * is a capability URL that leaks through history and screenshots. The masked view is built from an
 * ALLOWLIST, so a field added to the order later (notes, extra-amount note, InstaPay details, buyer
 * contact, personalisation text...) is absent by default. Status, lines and money stay (the success
 * page and the payment-return page still work); the address shrinks to city / state / country.
 */
export function maskGuestOrderView(order: object): Record<string, unknown> {
  const o = order as Record<string, unknown>;
  const out = pick(o, GUEST_ORDER_FIELDS);
  if (Array.isArray(o.items)) {
    out.items = o.items.map(i => pick(i as Record<string, unknown>, GUEST_ITEM_FIELDS));
  }
  if (Array.isArray(o.payments)) {
    out.payments = o.payments.map(p => {
      const x = p as Record<string, unknown>;
      return { provider: x.provider ?? null, method: x.method ?? null };
    });
  }
  const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
  out.shippingAddress = {
    city: a.city ?? null,
    state: a.state ?? null,
    country: a.country ?? null,
  };
  out.viewMasked = true;
  return out;
}
