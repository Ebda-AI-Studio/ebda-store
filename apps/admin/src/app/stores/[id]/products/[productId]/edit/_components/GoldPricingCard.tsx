'use client';

/**
 * GoldPricingCard (Phase B5 Task 13): price one product from today's gold rate instead of a typed price.
 *
 * The card never writes a price: it sends the SPEC (karat, grams, making charge, margin) and the server
 * computes and stores the price (Ruling B5-13). The live preview below uses the same `computeGoldUnitPrice`
 * the server runs, on the same integers, so what the merchant sees is what the repricer will write. Switching
 * to gold pricing is refused without a fresh rate for the product's karat. A variant may carry its own weight
 * (a ring in another size); everything else it inherits.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  bpsToPercentString,
  computeGoldUnitPrice,
  GOLD_KARATS,
  minorToDecimalString,
  mgToGramsString,
  parseGramsToMg,
  parsePercentToBps,
  tryToMinor,
  type GoldKarat,
  type GoldRoundingStep,
  type MakingChargeType,
  type ProductFact,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../../../lib/api';
import { formatPrice } from '../../../../../../../lib/format';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
export interface GoldProductFields {
  id: string;
  pricingMode?: 'fixed' | 'gold_rate' | null;
  goldKarat?: number | null;
  goldWeightMg?: number | null;
  makingChargeType?: MakingChargeType | null;
  makingChargeValue?: number | null;
  goldMarginBps?: number | null;
  price: number;
}
interface VariantRow {
  id: string;
  title?: string | null;
  name?: string | null;
  goldWeightMg?: number | null;
}
interface RatesState {
  settings: { enabled: boolean; roundingStep: GoldRoundingStep };
  rates: { karat: GoldKarat; ratePerGram: number | null; stale: boolean }[];
}

const KARAT_IN_TEXT =
  /(?:(?:^|[^\d])(24|21|18)\s*(?:k\b|kt\b|karat|carat|قيراط|عيار)|(?:karat|carat|قيراط|عيار)\s*(24|21|18)(?!\d))/i;

/** The karat a fact claims when it differs from the priced karat, else null. */
export function factsKaratMismatch(facts: ProductFact[], karat: GoldKarat): number | null {
  for (const f of facts) {
    const m = KARAT_IN_TEXT.exec(`${f.value ?? ''} ${f.valueAr ?? ''}`);
    const found = m ? Number(m[1] ?? m[2]) : null;
    if (found !== null && found !== karat) return found;
  }
  return null;
}

export function GoldPricingCard({
  storeId,
  product,
  facts,
  onSaved,
}: {
  storeId: string;
  product: GoldProductFields;
  facts: ProductFact[];
  onSaved: () => void;
}) {
  const t = useT('goldRates.card');
  const [gold, setGold] = useState(product.pricingMode === 'gold_rate');
  const [karat, setKarat] = useState<GoldKarat>((product.goldKarat as GoldKarat) ?? 21);
  const [grams, setGrams] = useState(
    product.goldWeightMg ? mgToGramsString(product.goldWeightMg) : ''
  );
  const [makingType, setMakingType] = useState<MakingChargeType>(
    product.makingChargeType ?? 'per_gram'
  );
  const [making, setMaking] = useState(
    product.makingChargeValue ? minorToDecimalString(product.makingChargeValue) : ''
  );
  const [margin, setMargin] = useState(bpsToPercentString(product.goldMarginBps ?? 0));
  const [state, setState] = useState<RatesState | null>(null);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [vGrams, setVGrams] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await apiGet<RatesState>(`/api/v1/stores/${storeId}/gold-rates`);
      if (r.data) setState(r.data);
      const v = await apiGet<{ variants: VariantRow[] }>(
        `/api/v1/stores/${storeId}/products/${product.id}/variants`
      );
      const rows = v.data?.variants ?? [];
      setVariants(rows);
      setVGrams(
        Object.fromEntries(
          rows.map(x => [x.id, x.goldWeightMg ? mgToGramsString(x.goldWeightMg) : ''])
        )
      );
    })();
  }, [storeId, product.id]);

  const parsed = useMemo(() => {
    const weightMg = parseGramsToMg(grams);
    const makingValue = making.trim() === '' ? 0 : tryToMinor(making);
    const marginBps = parsePercentToBps(margin);
    return { weightMg, makingValue, marginBps };
  }, [grams, making, margin]);

  // The store switch gates turning gold pricing ON; a product can always be switched OFF.
  const storeOff = state !== null && !state.settings.enabled;
  const rate = state?.rates.find(r => r.karat === karat);
  const freshRate = rate?.ratePerGram && !rate.stale ? rate.ratePerGram : null;
  const preview = useMemo(() => {
    if (!gold || !freshRate || !state) return null;
    if (parsed.weightMg === null || parsed.makingValue === null || parsed.marginBps === null)
      return null;
    try {
      return computeGoldUnitPrice(
        {
          karat,
          weightMg: parsed.weightMg,
          makingChargeType: makingType,
          makingChargeValue: parsed.makingValue,
          marginBps: parsed.marginBps,
        },
        freshRate,
        state.settings.roundingStep
      );
    } catch {
      return null;
    }
  }, [gold, freshRate, state, parsed, karat, makingType]);

  // A 21k piece whose own facts say "18k" is the classic mistake: warn, never block.
  const lint = useMemo(() => factsKaratMismatch(facts, karat), [facts, karat]);

  const save = async (nextGold: boolean) => {
    setMsg(null);
    if (nextGold) {
      if (parsed.weightMg === null) return setMsg({ ok: false, text: t('badWeight') });
      if (parsed.makingValue === null) return setMsg({ ok: false, text: t('badMaking') });
      if (parsed.marginBps === null) return setMsg({ ok: false, text: t('badMargin') });
      if (!freshRate) return setMsg({ ok: false, text: t('needFreshRate') });
    }
    const variantSlices: Record<string, unknown>[] = [];
    if (nextGold)
      for (const v of variants) {
        const raw = (vGrams[v.id] ?? '').trim();
        const mg = raw === '' ? null : parseGramsToMg(raw);
        if (raw !== '' && mg === null) return setMsg({ ok: false, text: t('badWeight') });
        variantSlices.push({ id: v.id, pricingMode: null, weightMg: mg });
      }
    setSaving(true);
    const { error } = await apiPut(
      `/api/v1/stores/${storeId}/gold-rates/products/${product.id}/pricing`,
      {
        product: nextGold
          ? {
              pricingMode: 'gold_rate',
              karat,
              weightMg: parsed.weightMg,
              makingChargeType: makingType,
              makingChargeValue: parsed.makingValue,
              marginBps: parsed.marginBps,
            }
          : { pricingMode: 'fixed' },
        ...(variantSlices.length ? { variants: variantSlices } : {}),
      }
    );
    setSaving(false);
    if (error) {
      const known: Record<string, string> = {
        GOLD_RATE_STALE: 'needFreshRate',
        GOLD_RATE_MISSING: 'needFreshRate',
        GOLD_IN_BUNDLE: 'inBundle',
        GOLD_NO_PRICE_TIERS: 'noTiers',
        GOLD_CATALOGUE_TOO_LARGE: 'tooLarge',
      };
      return setMsg({ ok: false, text: t((known[error.code] ?? 'saveFailed') as 'saveFailed') });
    }
    setGold(nextGold);
    setMsg({ ok: true, text: t('saved') });
    onSaved();
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm" data-setting-id="gold.productPricing">
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('body')}</p>

      <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={gold}
          disabled={saving || (storeOff && !gold)}
          onChange={e => (e.target.checked ? setGold(true) : void save(false))}
          className="h-5 w-5"
        />
        <span className="font-medium">{t('toggle')}</span>
      </label>
      {storeOff && (
        <p className="text-xs text-muted-foreground" data-testid="gold-store-off">
          {gold ? t('featureOffSaved') : t('featureOff')}
        </p>
      )}

      {gold && !storeOff && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">{t('karat')}</span>
              <select
                value={karat}
                onChange={e => setKarat(Number(e.target.value) as GoldKarat)}
                className={`${FIELD_CLASSES} mt-1 block`}
              >
                {GOLD_KARATS.map(k => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium">{t('grams')}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                value={grams}
                onChange={e => setGrams(e.target.value)}
                className={`${FIELD_CLASSES} mt-1 block`}
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('gramsHint')}</span>
            </label>
            <label className="block text-sm">
              <span className="font-medium">{t('makingType')}</span>
              <select
                value={makingType}
                onChange={e => setMakingType(e.target.value as MakingChargeType)}
                className={`${FIELD_CLASSES} mt-1 block`}
              >
                <option value="per_gram">{t('perGram')}</option>
                <option value="fixed">{t('fixed')}</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium">{t('making')}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                value={making}
                onChange={e => setMaking(e.target.value)}
                className={`${FIELD_CLASSES} mt-1 block`}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">{t('margin')}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                value={margin}
                onChange={e => setMargin(e.target.value)}
                className={`${FIELD_CLASSES} mt-1 block`}
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('marginHint')}</span>
            </label>
            <label className="block text-sm">
              <span className="font-medium">{t('price')}</span>
              <input
                disabled
                readOnly
                value={minorToDecimalString(product.price)}
                dir="ltr"
                className={`${FIELD_CLASSES} mt-1 block`}
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('priceHint')}</span>
            </label>
          </div>

          {variants.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">{t('variantsTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('variantsHint')}</p>
              <ul className="mt-2 space-y-2">
                {variants.map(v => (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span>{v.title ?? v.name ?? v.id.slice(0, 8)}</span>
                    <input
                      dir="ltr"
                      inputMode="decimal"
                      aria-label={t('variantGrams')}
                      placeholder={t('inherit')}
                      value={vGrams[v.id] ?? ''}
                      onChange={e => setVGrams(m => ({ ...m, [v.id]: e.target.value }))}
                      className={`${FIELD_CLASSES} w-32`}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-md bg-muted/50 p-3 text-sm" aria-live="polite">
            {preview ? (
              <>
                <p className="font-medium">
                  {t('preview', { price: formatPrice(preview.unitPrice) })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('previewSplit', {
                    metal: formatPrice(preview.metalValue),
                    making: formatPrice(preview.makingValue),
                  })}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                {freshRate ? t('previewIncomplete') : t('needFreshRate')}
              </p>
            )}
            {lint !== null && (
              <p role="note" className="mt-2 text-xs text-warning-ink">
                {t('factsMismatch', { karat: lint })}
              </p>
            )}
          </div>

          <Button type="button" disabled={saving} onClick={() => void save(true)} variant="default">
            {t('save')}
          </Button>
        </div>
      )}
      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`mt-3 text-sm ${msg.ok ? '' : 'text-destructive-ink'}`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
