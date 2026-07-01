'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Input, useToast } from '@force/ui';
import { recommendedSizeTextForTemplate, type TemplateId } from '@force/shared';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '@/components/ImageUpload';
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
  priceKwd: string;
  compareAtKwd: string;
  costKwd: string;
  inventory: string;
  imageUrl: string;
}

function newRowId(): string {
  return `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

function filsToKwd(fils: number | null): string {
  return fils !== null ? (fils / 1000).toFixed(3) : '';
}

function rowFromVariant(variant: Variant, primaryOptionId: string | null, multiAxis: boolean): Row {
  const ov = primaryOptionId
    ? variant.optionValues.find(v => v.optionId === primaryOptionId)
    : variant.optionValues[0];
  // Multi-axis variants have a combined title like "Small / Red". The
  // simple form locks this column, so use the variant title as the
  // display value (and skip the Arabic field — there's no clean
  // single-axis Arabic equivalent for a multi-axis combo).
  const value = multiAxis ? variant.title : (ov?.value ?? '');
  const valueAr = multiAxis ? (variant.titleAr ?? '') : (ov?.valueAr ?? '');
  return {
    rowId: variant.id,
    variantId: variant.id,
    value,
    valueAr,
    priceKwd: filsToKwd(variant.price),
    compareAtKwd: filsToKwd(variant.compareAtPrice),
    costKwd: filsToKwd(variant.costPrice),
    inventory: String(Math.max(0, variant.inventory ?? 0)),
    imageUrl: variant.imageUrl ?? '',
  };
}

function emptyRow(): Row {
  return {
    rowId: newRowId(),
    value: '',
    valueAr: '',
    priceKwd: '',
    compareAtKwd: '',
    costKwd: '',
    inventory: '0',
    imageUrl: '',
  };
}

function kwdInputToFils(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
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

  const primaryOption = options[0] ?? null;
  // Multi-axis: 2+ option axes (Size × Color etc.). Locks the name
  // columns since the simple table can't author cross-axis combos.
  const multiAxis = options.length >= 2;

  const [rows, setRows] = useState<Row[]>(() => {
    if (variants.length === 0) {
      return [emptyRow(), emptyRow()];
    }
    return variants.map(v => rowFromVariant(v, primaryOption?.id ?? null, multiAxis));
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
        v =>
          existingByVariantId.get(v.id) ?? rowFromVariant(v, primaryOption?.id ?? null, multiAxis)
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
      const ok = window.confirm(t('confirmDelete', { name: target.value || target.variantId }));
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
      if (!r.priceKwd.trim()) return t('errorPriceRequired', { name: r.value.trim() || '—' });
      const price = parseFloat(r.priceKwd);
      if (!Number.isFinite(price) || price < 0)
        return t('errorPriceInvalid', { name: r.value.trim() || '—' });
    }
    return null;
  }, [rows, t, multiAxis]);

  async function patchVariant(variantId: string, row: Row): Promise<boolean> {
    const { error } = await apiPut(
      `/api/v1/stores/${storeId}/products/${productId}/variants/${variantId}`,
      {
        price: kwdInputToFils(row.priceKwd),
        compareAtPrice: kwdInputToFils(row.compareAtKwd),
        costPrice: kwdInputToFils(row.costKwd),
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
          nameAr: t('defaultOptionNameAr'),
          values: populated.map(r => ({
            value: r.value.trim(),
            valueAr: r.valueAr.trim() || undefined,
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
              { value: r.value.trim(), valueAr: r.valueAr.trim() || undefined }
            );
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
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {multiAxis ? t('descriptionMultiAxis') : t('description')}
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((row, idx) => (
          <div key={row.rowId} className="rounded-lg border border-border bg-background p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colName')}
                  </p>
                )}
                <Input
                  value={row.value}
                  onChange={e => updateRow(row.rowId, { value: e.target.value })}
                  placeholder={t('namePlaceholder')}
                  disabled={multiAxis}
                />
              </div>
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colNameAr')}
                  </p>
                )}
                <Input
                  value={row.valueAr}
                  onChange={e => updateRow(row.rowId, { valueAr: e.target.value })}
                  placeholder={t('nameArPlaceholder')}
                  dir="rtl"
                  lang="ar"
                  disabled={multiAxis}
                />
              </div>
            </div>

            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_120px_auto]">
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colPrice')}
                  </p>
                )}
                <Input
                  type="number"
                  step="0.001"
                  value={row.priceKwd}
                  onChange={e => updateRow(row.rowId, { priceKwd: e.target.value })}
                  placeholder="0.000"
                />
              </div>
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colCompareAt')}
                  </p>
                )}
                <Input
                  type="number"
                  step="0.001"
                  value={row.compareAtKwd}
                  onChange={e => updateRow(row.rowId, { compareAtKwd: e.target.value })}
                  placeholder="—"
                />
              </div>
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colCost')}
                  </p>
                )}
                <Input
                  type="number"
                  step="0.001"
                  value={row.costKwd}
                  onChange={e => updateRow(row.rowId, { costKwd: e.target.value })}
                  placeholder="—"
                />
              </div>
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colStock')}
                  </p>
                )}
                <Input
                  type="number"
                  value={row.inventory}
                  onChange={e => updateRow(row.rowId, { inventory: e.target.value })}
                />
              </div>
              <div>
                {idx === 0 && (
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t('colImage')}
                  </p>
                )}
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
                <button
                  type="button"
                  onClick={() => removeRow(row.rowId)}
                  disabled={rows.length === 1 && !row.variantId}
                  className="text-sm text-destructive hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground/50"
                  aria-label={t('removeRow')}
                >
                  {t('removeRow')}
                </button>
              </div>
            </div>
          </div>
        ))}
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
            <p className="text-xs text-destructive">{validationError}</p>
          )}
          <Button onClick={handleSave} disabled={saving || !!validationError}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      {product.sku && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t('parentSkuNote', { sku: product.sku })}
        </p>
      )}
    </div>
  );
}
