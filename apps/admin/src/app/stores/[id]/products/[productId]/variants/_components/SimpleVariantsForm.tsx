'use client';

import { useEffect, useMemo, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import {
  recommendedSizeTextForTemplate,
  type TemplateId,
  minorToDecimalString,
  roundToMinor,
  DEFAULT_THEME,
  resolveColor,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '@/components/ImageUpload';
import { ColorField } from '@/components/ColorField';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../../../../lib/api';
import type { Option, Variant, ProductInfo } from './types';

/**
 * One-shot variants editor — the ONLY variant UI in the admin.
 *
 * Each row is one sellable variant. Columns: name (en), name (ar),
 * price, compare-at, cost, stock, image, delete. No options-vs-variants
 * distinction is exposed: behind the scenes the form ensures one option
 * exists, syncs values to rows, generates the variants, then PUTs each
 * row's pricing/stock/image.
 *
 * Multi-axis products (Size × Color, etc.) created by older flows still
 * load here — every variant is shown as a flat row with its combined
 * title locked (the simple form can't author new combinations across
 * two axes, so we stop the merchant from renaming them, but
 * price/stock/image edits and deletes still work).
 */

interface SimpleVariantsFormProps {
  storeId: string;
  productId: string;
  product: ProductInfo;
  options: Option[];
  variants: Variant[];
  onSaved: () => void;
}

interface Row {
  rowId: string;
  /** Existing variant id when this row maps to one already on the server. */
  variantId?: string;
  /** The option value (e.g. "4 liters"). Locked when multi-axis. */
  value: string;
  valueAr: string;
  /** Swatch for the option value (single-axis only). '' = none. */
  swatchHex: string;
  swatchImageUrl: string;
  priceMajor: string;
  compareAtMajor: string;
  costMajor: string;
  inventory: string;
  imageUrl: string;
}

function newRowId(): string {
  return `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

function minorToMajor(piastres: number | null): string {
  return piastres !== null ? minorToDecimalString(piastres) : '';
}

function rowFromVariant(variant: Variant, primaryOption: Option | null, multiAxis: boolean): Row {
  const primaryOptionId = primaryOption?.id ?? null;
  const ov = primaryOptionId
    ? variant.optionValues.find(v => v.optionId === primaryOptionId)
    : variant.optionValues[0];
  // Multi-axis variants have a combined title like "Small / Red". The
  // simple form locks this column, so use the variant title as the
  // display value (and skip the Arabic field — there's no clean
  // single-axis Arabic equivalent for a multi-axis combo).
  const value = multiAxis ? variant.title : (ov?.value ?? '');
  const valueAr = multiAxis ? (variant.titleAr ?? '') : (ov?.valueAr ?? '');
  const stored = ov ? primaryOption?.values.find(v => v.id === ov.valueId) : undefined;
  return {
    rowId: variant.id,
    variantId: variant.id,
    value,
    valueAr,
    swatchHex: multiAxis ? '' : (stored?.swatchHex ?? ''),
    swatchImageUrl: multiAxis ? '' : (stored?.swatchImageUrl ?? ''),
    priceMajor: minorToMajor(variant.price),
    compareAtMajor: minorToMajor(variant.compareAtPrice),
    costMajor: minorToMajor(variant.costPrice),
    inventory: String(Math.max(0, variant.inventory ?? 0)),
    imageUrl: variant.imageUrl ?? '',
  };
}

function emptyRow(): Row {
  return {
    rowId: newRowId(),
    value: '',
    valueAr: '',
    swatchHex: '',
    swatchImageUrl: '',
    priceMajor: '',
    compareAtMajor: '',
    costMajor: '',
    inventory: '0',
    imageUrl: '',
  };
}

function majorInputToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n)) return null;
  return roundToMinor(n);
}

export function SimpleVariantsForm({
  storeId,
  productId,
  product,
  options,
  variants,
  onSaved,
}: SimpleVariantsFormProps) {
  const t = useT('products.variants.simpleForm');
  const { success: toastSuccess, error: toastError } = useToast();
  const askConfirm = useConfirm();

  const primaryOption = options[0] ?? null;
  // Multi-axis: 2+ option axes (Size × Color etc.). Locks the name
  // columns since the simple table can't author cross-axis combos.
  const multiAxis = options.length >= 2;

  const [rows, setRows] = useState<Row[]>(() => {
    if (variants.length === 0) {
      return [emptyRow(), emptyRow()];
    }
    return variants.map(v => rowFromVariant(v, primaryOption, multiAxis));
  });
  const [saving, setSaving] = useState(false);
  /** Template of the store — used to show per-theme recommended upload sizes. */
  const [storeTemplate, setStoreTemplate] = useState<TemplateId | undefined>();

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ store: { template?: TemplateId } }>(`/api/v1/admin/stores/${storeId}`)
      .then(({ data }) => {
        if (data?.store?.template) setStoreTemplate(data.store.template);
      })
      .catch(() => {
        // non-critical — falls back to base recommended size
      });
  }, [storeId]);
  // Per-row delete in-flight set. Without this a rapid double-click on
  // the row's delete button fires two DELETE requests against the same
  // variantId — the first succeeds, the second returns 404 ("Variant
  // not found") and surfaces an error toast for what was actually a
  // successful operation.
  const [deletingRows, setDeletingRows] = useState<Set<string>>(new Set());

  // Re-hydrate when the upstream variant list changes (after a save
  // round-trip). Preserves in-flight edits via row id matching.
  useEffect(() => {
    if (variants.length === 0) return;
    setRows(prev => {
      const existingByVariantId = new Map(
        prev.filter(r => r.variantId).map(r => [r.variantId!, r] as const)
      );
      return variants.map(
        v => existingByVariantId.get(v.id) ?? rowFromVariant(v, primaryOption, multiAxis)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants]);

  function updateRow(rowId: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }

  async function removeRow(rowId: string) {
    const target = rows.find(r => r.rowId === rowId);
    if (!target) return;
    // Re-entrancy guard. The user can mash the delete button before
    // the server has acknowledged the first DELETE; the second call
    // would 404 because the variant is already gone. Skip silently.
    if (deletingRows.has(rowId)) return;

    // Existing variant: delete on the server immediately so the row
    // doesn't reappear after a save round-trip.
    if (target.variantId) {
      const ok = await askConfirm({
        object: t('deleteDialog.object', { name: target.value || target.variantId }),
        consequence: t('deleteDialog.consequence'),
        confirmLabel: t('deleteDialog.confirmLabel'),
      });
      if (!ok) return;
      setDeletingRows(prev => new Set(prev).add(rowId));
      // Optimistically remove the row from the visible list so a
      // double-click can't re-target it.
      setRows(prev => (prev.length > 1 ? prev.filter(r => r.rowId !== rowId) : prev));
      const { error } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${productId}/variants/${target.variantId}`
      );
      // 404 here means the variant was already deleted (concurrent
      // tab, prior click that finished after we showed the row, …).
      // Treat as success — the desired end state is reached.
      const treatAsSuccess = !error || error.code === 'NOT_FOUND' || error.status === 404;
      if (!treatAsSuccess) {
        toastError(t('saveFailedTitle'), error.message);
        // Roll back the optimistic removal so the merchant can retry.
        setRows(prev => [...prev, target]);
      }
      setDeletingRows(prev => {
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
      onSaved();
      return;
    }
    // Local-only row: just drop it.
    setRows(prev => (prev.length > 1 ? prev.filter(r => r.rowId !== rowId) : prev));
  }

  function addRow() {
    setRows(prev => [...prev, emptyRow()]);
  }

  // Validation summary — shown next to Save so the merchant sees why
  // the click is disabled. Skipped entirely in multi-axis mode (names
  // are server-managed there).
  const validationError = useMemo(() => {
    const populated = multiAxis ? rows.filter(r => r.variantId) : rows.filter(r => r.value.trim());
    if (populated.length === 0) return t('errorNoRows');
    if (!multiAxis) {
      const seen = new Set<string>();
      for (const r of populated) {
        const key = r.value.trim().toLowerCase();
        if (seen.has(key)) return t('errorDuplicate', { name: r.value.trim() });
        seen.add(key);
      }
    }
    for (const r of populated) {
      if (!r.priceMajor.trim()) return t('errorPriceRequired', { name: r.value.trim() || '—' });
      const price = parseFloat(r.priceMajor);
      if (!Number.isFinite(price) || price < 0)
        return t('errorPriceInvalid', { name: r.value.trim() || '—' });
    }
    return null;
  }, [rows, t, multiAxis]);

  async function patchVariant(variantId: string, row: Row): Promise<boolean> {
    const { error } = await apiPut(
      `/api/v1/stores/${storeId}/products/${productId}/variants/${variantId}`,
      {
        price: majorInputToMinor(row.priceMajor),
        compareAtPrice: majorInputToMinor(row.compareAtMajor),
        costPrice: majorInputToMinor(row.costMajor),
        inventory: parseInt(row.inventory) || 0,
        imageUrl: row.imageUrl || null,
      }
    );
    return !error;
  }

  async function handleSave() {
    if (validationError) {
      toastError(t('saveBlockedTitle'), validationError);
      return;
    }
    setSaving(true);
    try {
      // Multi-axis: only patch existing variants (name editing is locked
      // since we can't author cross-axis combos here).
      if (multiAxis) {
        const populated = rows.filter(r => r.variantId);
        let failed = 0;
        await Promise.all(
          populated.map(async row => {
            const ok = await patchVariant(row.variantId!, row);
            if (!ok) failed++;
          })
        );
        if (failed === 0) {
          toastSuccess(t('savedTitle'), t('savedDescription', { count: populated.length }));
        } else {
          toastError(
            t('partialFailTitle'),
            t('partialFailDescription', { failed, total: populated.length })
          );
        }
        onSaved();
        return;
      }

      const populated = rows.filter(r => r.value.trim());

      // 1. Ensure exactly one option exists. Create when missing.
      let optionId = primaryOption?.id ?? null;
      if (!optionId) {
        const { data: optionRes, error: optionErr } = await apiPost<{
          option: { id: string };
        }>(`/api/v1/stores/${storeId}/products/${productId}/options`, {
          name: t('defaultOptionName'),
          // Leave nameAr blank so the Arabic storefront derives the axis label
          // smartly from the values (weight → الوزن, volume → الحجم, size →
          // المقاس). Stamping a generic "متغير" here surfaced it verbatim on the
          // PDP. See apps/web/src/lib/option-localization.ts.
          nameAr: undefined,
          values: populated.map(r => ({
            value: r.value.trim(),
            valueAr: r.valueAr.trim() || undefined,
            swatchHex: r.swatchHex || undefined,
            swatchImageUrl: r.swatchImageUrl || undefined,
          })),
        });
        if (optionErr || !optionRes?.option?.id) {
          toastError(t('saveFailedTitle'), optionErr?.message ?? '');
          return;
        }
        optionId = optionRes.option.id;
      } else {
        // 2. Diff: add values that don't yet exist on the option, remove
        // values whose row was deleted.
        const existingValues = new Map(
          (primaryOption?.values ?? []).map(v => [v.value.trim().toLowerCase(), v])
        );
        const desiredValues = new Set(populated.map(r => r.value.trim().toLowerCase()));

        for (const r of populated) {
          const key = r.value.trim().toLowerCase();
          if (!existingValues.has(key)) {
            await apiPost(
              `/api/v1/stores/${storeId}/products/${productId}/options/${optionId}/values`,
              {
                value: r.value.trim(),
                valueAr: r.valueAr.trim() || undefined,
                swatchHex: r.swatchHex || undefined,
                swatchImageUrl: r.swatchImageUrl || undefined,
              }
            );
          } else {
            // Existing value: PUT only when its swatch changed (null clears).
            const stored = existingValues.get(key)!;
            if (
              (stored.swatchHex ?? '') !== r.swatchHex ||
              (stored.swatchImageUrl ?? '') !== r.swatchImageUrl
            ) {
              await apiPut(
                `/api/v1/stores/${storeId}/products/${productId}/option-values/${stored.id}`,
                {
                  swatchHex: r.swatchHex || null,
                  swatchImageUrl: r.swatchImageUrl || null,
                }
              );
            }
          }
        }
        for (const [key, v] of existingValues) {
          if (!desiredValues.has(key)) {
            await apiDelete(
              `/api/v1/stores/${storeId}/products/${productId}/option-values/${v.id}`
            );
          }
        }
      }

      // 3. Generate any missing variant rows.
      await apiPost(`/api/v1/stores/${storeId}/products/${productId}/variants/generate`);

      // 4. Re-fetch so we know the IDs to update. Match row → variant
      //    by the option value text we just created.
      const { data: refreshed } = await apiGet<{
        product: ProductInfo;
        options: Option[];
        variants: Variant[];
      }>(`/api/v1/stores/${storeId}/products/${productId}/variants`);
      const freshVariants: Variant[] = refreshed?.variants ?? [];

      const valueToVariant = new Map<string, Variant>();
      for (const v of freshVariants) {
        const ov = v.optionValues.find(o => o.optionId === optionId);
        if (ov) valueToVariant.set(ov.value.trim().toLowerCase(), v);
      }
      let failed = 0;
      await Promise.all(
        populated.map(async row => {
          const v = valueToVariant.get(row.value.trim().toLowerCase());
          if (!v) {
            failed++;
            return;
          }
          const ok = await patchVariant(v.id, row);
          if (!ok) failed++;
        })
      );

      if (failed === 0) {
        toastSuccess(t('savedTitle'), t('savedDescription', { count: populated.length }));
      } else {
        toastError(
          t('partialFailTitle'),
          t('partialFailDescription', { failed, total: populated.length })
        );
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save variants:', err);
      toastError(t('saveFailedTitle'), err instanceof Error ? err.message : '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border bg-card p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {multiAxis ? t('descriptionMultiAxis') : t('description')}
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((row, idx) => {
          // Every row repeated its 6 column labels in full — visually a
          // wall of "Name / Name (Arabic) / Price / Compare-at / Cost /
          // Stock" text before every single variant, all after the first
          // row said it once already. The label stays for the input's
          // accessible name (still `htmlFor`-linked, screen readers still
          // read it per row) — only the SIGHTED repetition goes, via
          // `sr-only` on every row after the first.
          const labelClass =
            idx === 0 ? 'mb-1 block text-xs font-medium text-muted-foreground' : 'sr-only';
          return (
            <div key={row.rowId} className="rounded-lg border border-border bg-background p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor={`variant-name-${row.rowId}`} className={labelClass}>
                    {t('colName')}
                  </label>
                  <Input
                    id={`variant-name-${row.rowId}`}
                    value={row.value}
                    onChange={e => updateRow(row.rowId, { value: e.target.value })}
                    placeholder={t('namePlaceholder')}
                    disabled={multiAxis}
                  />
                </div>
                <div>
                  <label htmlFor={`variant-name-ar-${row.rowId}`} className={labelClass}>
                    {t('colNameAr')}
                  </label>
                  <Input
                    id={`variant-name-ar-${row.rowId}`}
                    value={row.valueAr}
                    onChange={e => updateRow(row.rowId, { valueAr: e.target.value })}
                    placeholder={t('nameArPlaceholder')}
                    dir="rtl"
                    lang="ar"
                    disabled={multiAxis}
                  />
                </div>
              </div>

              {!multiAxis && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ColorField
                    label={t('colSwatchColor')}
                    value={row.swatchHex || undefined}
                    theme={DEFAULT_THEME}
                    showContrastPreview={false}
                    onChange={c => {
                      // A swatch is a concrete hex, never a theme token.
                      const hex = c.startsWith('#') ? c : resolveColor(c, DEFAULT_THEME);
                      if (!c) updateRow(row.rowId, { swatchHex: '' });
                      else if (hex && /^#[0-9a-fA-F]{6}$/.test(hex))
                        updateRow(row.rowId, { swatchHex: hex.toLowerCase() });
                    }}
                  />
                  <div>
                    <span className={labelClass}>{t('colSwatchImage')}</span>
                    <ImageUpload
                      value={row.swatchImageUrl || undefined}
                      onUpload={url => updateRow(row.rowId, { swatchImageUrl: url })}
                      onRemove={() => updateRow(row.rowId, { swatchImageUrl: '' })}
                      folder="products"
                      storeId={storeId}
                    />
                  </div>
                </div>
              )}

              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_120px_auto]">
                <div>
                  <label htmlFor={`variant-price-${row.rowId}`} className={labelClass}>
                    {t('colPrice')}
                  </label>
                  <Input
                    id={`variant-price-${row.rowId}`}
                    type="number"
                    step="0.01"
                    value={row.priceMajor}
                    onChange={e => updateRow(row.rowId, { priceMajor: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label htmlFor={`variant-compare-at-${row.rowId}`} className={labelClass}>
                    {t('colCompareAt')}
                  </label>
                  <Input
                    id={`variant-compare-at-${row.rowId}`}
                    type="number"
                    step="0.01"
                    value={row.compareAtMajor}
                    onChange={e => updateRow(row.rowId, { compareAtMajor: e.target.value })}
                    placeholder="—"
                  />
                </div>
                <div>
                  <label htmlFor={`variant-cost-${row.rowId}`} className={labelClass}>
                    {t('colCost')}
                  </label>
                  <Input
                    id={`variant-cost-${row.rowId}`}
                    type="number"
                    step="0.01"
                    value={row.costMajor}
                    onChange={e => updateRow(row.rowId, { costMajor: e.target.value })}
                    placeholder="—"
                  />
                </div>
                <div>
                  <label htmlFor={`variant-stock-${row.rowId}`} className={labelClass}>
                    {t('colStock')}
                  </label>
                  <Input
                    id={`variant-stock-${row.rowId}`}
                    type="number"
                    value={row.inventory}
                    onChange={e => updateRow(row.rowId, { inventory: e.target.value })}
                  />
                </div>
                <div>
                  <span className={labelClass}>{t('colImage')}</span>
                  <ImageUpload
                    value={row.imageUrl || undefined}
                    onUpload={url => updateRow(row.rowId, { imageUrl: url })}
                    onRemove={() => updateRow(row.rowId, { imageUrl: '' })}
                    folder="products"
                    storeId={storeId}
                    recommendedSizeHint={recommendedSizeTextForTemplate(
                      'productPrimary',
                      storeTemplate
                    )}
                  />
                </div>
                <div className="flex items-end justify-end pb-1">
                  <Button
                    type="button"
                    onClick={() => removeRow(row.rowId)}
                    disabled={rows.length === 1 && !row.variantId}
                    aria-label={t('removeRow')}
                    variant="link"
                    className="text-destructive-ink"
                  >
                    {t('removeRow')}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {!multiAxis ? (
          <Button variant="outline" onClick={addRow} disabled={saving}>
            + {t('addRow')}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t('multiAxisLockNote')}</p>
        )}
        <div className="flex items-center gap-3">
          {validationError && !saving && (
            <p className="text-xs text-destructive-ink">{validationError}</p>
          )}
          <Button onClick={handleSave} disabled={saving || !!validationError}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      {product.sku && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('parentSkuNote', { sku: product.sku })}
        </p>
      )}
    </div>
  );
}
