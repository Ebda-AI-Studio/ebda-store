'use client';

import { useMemo, useState } from 'react';
import { Button, Input, Label } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { Option, Variant } from './types';

/**
 * Linear "scale prices by weight" panel. Renders above the variants table
 * when a weight-like option is detected on the product. The merchant
 * picks one variant + reference values for any combination of price,
 * compare-at price, and cost; we scale every other variant's matching
 * field proportionally to its weight (parsed from the option value
 * string, e.g. "250g", "500 grams", "1 kg", "1 كيلو", "1.5kg").
 *
 * Scope: this is a one-shot bulk operation, not live tracking. The
 * merchant clicks Apply, prices populate, and from then on each variant
 * is independently editable so they can hand-tune outliers afterwards.
 * Linear scaling only — tiered/bulk discounts are intentionally out of
 * scope here; the merchant edits per-variant for non-linear pricing.
 *
 * Detection rule: option name contains "weight"/"وزن" OR more than half
 * of the option's values parse to a known weight string. False positives
 * are harmless — the card just renders without a workable list of
 * variants and the Apply button stays disabled.
 */

type Variants = readonly Variant[];

export interface WeightScaleUpdate {
  variantId: string;
  price?: number;
  compareAtPrice?: number;
  costPrice?: number;
}

interface WeightScaleCardProps {
  options: Option[];
  variants: Variants;
  /** Caller (the parent page) does the actual API write. We give it a
   *  per-variant update with only the fields the merchant chose to
   *  scale, in fils. */
  onApply: (updates: WeightScaleUpdate[]) => Promise<void> | void;
}

/** Convert a value string like "250g" / "1 kg" / "1.5 كيلو" to grams.
 *  Returns null when the string doesn't parse — the variant is then
 *  excluded from scaling. */
function parseWeight(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*([a-z؀-ۿ]*)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  // Default unit when none specified: grams (the most common case for
  // food / spice / coffee variants in KW).
  if (!unit) return n;
  if (/^(g|gm|gms|gram|grams|gr|غم|جرام|غرام)$/.test(unit)) return n;
  if (/^(kg|kgs|kilo|kilogram|kilograms|كغ|كيلو|كيلوغرام|كيلوجرام)$/.test(unit)) return n * 1000;
  if (/^(mg|ميلليغرام|ملغم)$/.test(unit)) return n / 1000;
  if (/^(oz|ounce|ounces|أونصة|اونصة)$/.test(unit)) return n * 28.3495;
  if (/^(lb|lbs|pound|pounds|باوند|رطل)$/.test(unit)) return n * 453.592;
  return null;
}

/** Pick the option that looks like a weight axis. Heuristic: name
 *  contains "weight"/"وزن", OR most of its values parse as weight. */
function detectWeightOption(options: Option[]): Option | null {
  if (!options || options.length === 0) return null;
  for (const opt of options) {
    const lname = opt.name.toLowerCase();
    if (lname.includes('weight') || opt.nameAr?.includes('وزن')) return opt;
    const values = opt.values ?? [];
    if (values.length === 0) continue;
    const parsed = values.filter(v => parseWeight(v.value) !== null);
    if (parsed.length >= Math.ceil(values.length * 0.6)) {
      return opt;
    }
  }
  return null;
}

/** Parse a KWD string ("1.500" / "1.5" / "" ) into fils. Returns null
 *  when the string is empty or non-numeric. */
function parseKwd(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function WeightScaleCard({ options, variants, onApply }: WeightScaleCardProps) {
  const t = useT('products.variants.weightScale');
  const weightOption = useMemo(() => detectWeightOption(options), [options]);

  // Map each variant to its grams (when its option-value parses).
  const variantWeights = useMemo(() => {
    if (!weightOption) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const v of variants) {
      const ovForOption = v.optionValues.find(ov => ov.optionId === weightOption.id);
      if (!ovForOption) continue;
      const grams = parseWeight(ovForOption.value);
      if (grams !== null) m.set(v.id, grams);
    }
    return m;
  }, [variants, weightOption]);

  const [referenceVariantId, setReferenceVariantId] = useState<string>('');
  const [refPrice, setRefPrice] = useState<string>('');
  const [refCompareAt, setRefCompareAt] = useState<string>('');
  const [refCost, setRefCost] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  if (!weightOption || variantWeights.size < 2) {
    return null;
  }

  const referenceWeight = referenceVariantId ? variantWeights.get(referenceVariantId) : undefined;
  const refPriceKwd = parseKwd(refPrice);
  const refCompareAtKwd = parseKwd(refCompareAt);
  const refCostKwd = parseKwd(refCost);
  const anyFieldFilled = refPriceKwd !== null || refCompareAtKwd !== null || refCostKwd !== null;
  const canApply = !!referenceWeight && anyFieldFilled;

  type PreviewRow = {
    variant: Variant;
    grams: number;
    price: number | null;
    compareAtPrice: number | null;
    costPrice: number | null;
  };

  const previewRows: PreviewRow[] = canApply
    ? variants
        .map(v => {
          const grams = variantWeights.get(v.id);
          if (!grams) return null;
          const ratio = grams / referenceWeight!;
          return {
            variant: v,
            grams,
            price: refPriceKwd !== null ? refPriceKwd * ratio : null,
            compareAtPrice: refCompareAtKwd !== null ? refCompareAtKwd * ratio : null,
            costPrice: refCostKwd !== null ? refCostKwd * ratio : null,
          };
        })
        .filter((row): row is PreviewRow => !!row)
        .sort((a, b) => a.grams - b.grams)
    : [];

  async function handleApply() {
    if (!canApply || submitting) return;
    setSubmitting(true);
    try {
      const updates: WeightScaleUpdate[] = previewRows.map(r => {
        const u: WeightScaleUpdate = { variantId: r.variant.id };
        if (r.price !== null) u.price = Math.round(r.price * 1000);
        if (r.compareAtPrice !== null) u.compareAtPrice = Math.round(r.compareAtPrice * 1000);
        if (r.costPrice !== null) u.costPrice = Math.round(r.costPrice * 1000);
        return u;
      });
      await onApply(updates);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 mb-6">
      <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="weight-ref-variant">{t('referenceVariant')}</Label>
          <select
            id="weight-ref-variant"
            value={referenceVariantId}
            onChange={e => setReferenceVariantId(e.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm h-10"
          >
            <option value="">{t('referenceVariantPlaceholder')}</option>
            {variants
              .filter(v => variantWeights.has(v.id))
              .sort((a, b) => variantWeights.get(a.id)! - variantWeights.get(b.id)!)
              .map(v => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('referenceVariantHint')}</p>
        </div>

        <div>
          <Label htmlFor="weight-ref-price">{t('referencePrice')}</Label>
          <Input
            id="weight-ref-price"
            type="number"
            step="0.001"
            value={refPrice}
            onChange={e => setRefPrice(e.target.value)}
            placeholder="0.000"
            className="mt-1"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t('referencePriceHint')}</p>
        </div>

        <div>
          <Label htmlFor="weight-ref-compare">{t('referenceCompareAt')}</Label>
          <Input
            id="weight-ref-compare"
            type="number"
            step="0.001"
            value={refCompareAt}
            onChange={e => setRefCompareAt(e.target.value)}
            placeholder={t('skipFieldPlaceholder')}
            className="mt-1"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t('referenceCompareAtHint')}</p>
        </div>

        <div>
          <Label htmlFor="weight-ref-cost">{t('referenceCost')}</Label>
          <Input
            id="weight-ref-cost"
            type="number"
            step="0.001"
            value={refCost}
            onChange={e => setRefCost(e.target.value)}
            placeholder={t('skipFieldPlaceholder')}
            className="mt-1"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t('referenceCostHint')}</p>
        </div>
      </div>

      {canApply && (
        <div className="mt-4 rounded-lg bg-card border border-border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('preview')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="text-start font-medium pb-1">{t('previewVariant')}</th>
                  {refPriceKwd !== null && (
                    <th className="text-end font-medium pb-1">{t('previewPrice')}</th>
                  )}
                  {refCompareAtKwd !== null && (
                    <th className="text-end font-medium pb-1">{t('previewCompareAt')}</th>
                  )}
                  {refCostKwd !== null && (
                    <th className="text-end font-medium pb-1">{t('previewCost')}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {previewRows.map(row => (
                  <tr key={row.variant.id} className="border-t border-border/40">
                    <td className="py-1.5 text-foreground">{row.variant.title}</td>
                    {refPriceKwd !== null && (
                      <td className="py-1.5 text-end font-medium tabular-nums">
                        {row.price?.toFixed(3)}
                      </td>
                    )}
                    {refCompareAtKwd !== null && (
                      <td className="py-1.5 text-end font-medium tabular-nums">
                        {row.compareAtPrice?.toFixed(3)}
                      </td>
                    )}
                    {refCostKwd !== null && (
                      <td className="py-1.5 text-end font-medium tabular-nums">
                        {row.costPrice?.toFixed(3)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button onClick={handleApply} disabled={!canApply || submitting}>
          {submitting ? t('applying') : t('apply')}
        </Button>
      </div>
    </div>
  );
}
