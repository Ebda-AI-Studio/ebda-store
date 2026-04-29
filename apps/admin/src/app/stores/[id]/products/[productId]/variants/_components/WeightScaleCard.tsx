'use client';

import { useMemo, useState } from 'react';
import { Button, Input, Label } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { Option, Variant } from './types';

/**
 * Linear "scale price by weight" panel. Renders above the variants table
 * when a weight-like option is detected on the product. The merchant
 * picks one variant + a base price; we scale every other variant's
 * price proportionally to its weight (parsed from the option value
 * string, e.g. "250g", "500 grams", "1 kg", "1 كيلو", "1.5kg").
 *
 * Scope: this is intentionally a one-shot bulk operation, not live
 * tracking. The merchant clicks Apply, prices populate, and from then
 * on each variant is independent (so they can hand-tune outliers
 * afterwards). Linear scaling only — no tiered/discounted breaks; if a
 * merchant needs custom rules they edit per-variant.
 *
 * Detection rule: option name contains "weight"/"وزن" OR more than half
 * of the option's values parse to a known weight string. False positives
 * are harmless — the card just renders without a workable list of
 * variants and the Apply button stays disabled.
 */

type Variants = readonly Variant[];

interface WeightScaleCardProps {
  options: Option[];
  variants: Variants;
  /** Caller (the parent page) does the actual API write. We give it the
   *  computed [variantId, priceInFils] tuples so the parent can batch
   *  the calls + show toasts consistently with `applyFieldToAllVariants`. */
  onApply: (updates: Array<{ variantId: string; price: number }>) => Promise<void> | void;
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
    if (
      lname.includes('weight') ||
      lname.includes('size') === false /* size is ambiguous, stay strict */ ||
      opt.nameAr?.includes('وزن')
    ) {
      // Name matches.
      if (lname.includes('weight') || opt.nameAr?.includes('وزن')) return opt;
    }
    const values = opt.values ?? [];
    if (values.length === 0) continue;
    const parsed = values.filter(v => parseWeight(v.value) !== null);
    if (parsed.length >= Math.ceil(values.length * 0.6)) {
      return opt;
    }
  }
  return null;
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
  const [referencePriceKwd, setReferencePriceKwd] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  if (!weightOption || variantWeights.size < 2) {
    return null;
  }

  const referenceWeight = referenceVariantId ? variantWeights.get(referenceVariantId) : undefined;
  const referencePriceKwdNum = parseFloat(referencePriceKwd);
  const canApply =
    !!referenceWeight && Number.isFinite(referencePriceKwdNum) && referencePriceKwdNum > 0;

  // Build the proportional preview so the merchant sees what will land
  // before clicking Apply. KWD here, fils inside the API call.
  const previewRows = canApply
    ? variants
        .map(v => {
          const grams = variantWeights.get(v.id);
          if (!grams) return null;
          const priceKwd = (referencePriceKwdNum * grams) / referenceWeight!;
          return { variant: v, grams, priceKwd };
        })
        .filter((row): row is { variant: Variant; grams: number; priceKwd: number } => !!row)
        .sort((a, b) => a.grams - b.grams)
    : [];

  async function handleApply() {
    if (!canApply || submitting) return;
    setSubmitting(true);
    try {
      const updates = previewRows.map(r => ({
        variantId: r.variant.id,
        price: Math.round(r.priceKwd * 1000),
      }));
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
        </div>
        <div>
          <Label htmlFor="weight-ref-price">{t('referencePrice')}</Label>
          <Input
            id="weight-ref-price"
            type="number"
            step="0.001"
            value={referencePriceKwd}
            onChange={e => setReferencePriceKwd(e.target.value)}
            placeholder="0.000"
            className="mt-1"
          />
        </div>
      </div>

      {canApply && (
        <div className="mt-4 rounded-lg bg-card border border-border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('preview')}
          </p>
          <ul className="space-y-1 text-sm">
            {previewRows.map(row => (
              <li key={row.variant.id} className="flex justify-between">
                <span className="text-foreground">{row.variant.title}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {row.priceKwd.toFixed(3)} KWD
                </span>
              </li>
            ))}
          </ul>
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
