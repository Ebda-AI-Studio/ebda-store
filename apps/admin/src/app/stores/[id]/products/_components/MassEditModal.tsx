'use client';

import { isVariantProduct } from '../../../../../lib/variant-product';
import { useState, useEffect } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import type { Product } from './types';
import { variantPriceToField, variantFieldToPrice } from '@/lib/variant-price';

import { roundToMinor } from '@ebda/shared';
// ─── local types ─────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  nameAr?: string;
}

interface Variant {
  id: string;
  title: string;
  titleAr?: string;
  sku?: string | null;
  /** Override price; null = inherits the product price (schema: Int?). */
  price: number | null;
  inventory: number;
}

interface ProductWithVariants {
  id: string;
  name: string;
  nameAr?: string;
  variants: Variant[];
}

type Tristate = 'noChange' | 'on' | 'off';
type PriceMode = 'set' | 'adjustPct';
type InventoryMode = 'set' | 'adjust';

// ─── helpers ─────────────────────────────────────────────────────────────────

const VARIANT_LOAD_CAP = 25;

function majorToMinor(major: string): number {
  const n = parseFloat(major);
  if (isNaN(n) || n < 0) return 0;
  return roundToMinor(n);
}

// ─── sub-components ──────────────────────────────────────────────────────────

interface TristateSelectProps {
  value: Tristate;
  onChange: (v: Tristate) => void;
  label: string;
  t: (key: string) => string;
}

function TristateSelect({ value, onChange, label, t }: TristateSelectProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-foreground w-32 shrink-0">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as Tristate)}
        className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <option value="noChange">{t('massEdit.tristate.noChange')}</option>
        <option value="on">{t('massEdit.tristate.on')}</option>
        <option value="off">{t('massEdit.tristate.off')}</option>
      </select>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

interface MassEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  storeId: string;
  selectedProducts: Product[];
  onSuccess: () => void;
}

export function MassEditModal({
  isOpen,
  onClose,
  storeId,
  selectedProducts,
  onSuccess,
}: MassEditModalProps) {
  const t = useT('products.list');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();

  const [activeTab, setActiveTab] = useState<'fields' | 'variants'>('fields');

  // ── Tab A state ─────────────────────────────────────────────────────────

  const [categories, setCategories] = useState<Category[]>([]);

  const [changeStatus, setChangeStatus] = useState(false);
  const [status, setStatus] = useState<'draft' | 'active' | 'archived'>('active');

  const [changeCat, setChangeCat] = useState(false);
  const [addCategoryId, setAddCategoryId] = useState('');

  const [isFeatured, setIsFeatured] = useState<Tristate>('noChange');
  const [isNew, setIsNew] = useState<Tristate>('noChange');
  const [isBestSeller, setIsBestSeller] = useState<Tristate>('noChange');

  const [changePrice, setChangePrice] = useState(false);
  const [priceMode, setPriceMode] = useState<PriceMode>('set');
  const [priceValue, setPriceValue] = useState('');

  // Gold-rate pricing switch (B5): '' = leave alone. Its own endpoint, because it reprices under a lock.
  const [goldSwitch, setGoldSwitch] = useState<'' | 'fixed' | 'gold_rate'>('');
  const tGold = useT('goldRates.bulk');

  const [changeInventory, setChangeInventory] = useState(false);
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>('set');
  const [inventoryValue, setInventoryValue] = useState('');

  const [applying, setApplying] = useState(false);

  // ── Tab B state ─────────────────────────────────────────────────────────

  const [variantProducts, setVariantProducts] = useState<ProductWithVariants[]>([]);
  const [variantEdits, setVariantEdits] = useState<
    Record<string, { inventory: string; price: string }>
  >({});
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [savingVariants, setSavingVariants] = useState(false);

  // ── derived ─────────────────────────────────────────────────────────────

  // The real variant rows (`variantCount` from the list), the column only as a
  // fallback: the same rule as the API's bulk update (W1b fix round).
  const variantSelectedProducts = selectedProducts.filter(p => isVariantProduct(p));
  const simpleSelectedProducts = selectedProducts.filter(p => !isVariantProduct(p));
  const variantProductsToLoad = variantSelectedProducts.slice(0, VARIANT_LOAD_CAP);
  const isCapped = variantSelectedProducts.length > VARIANT_LOAD_CAP;

  // ── effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;

    // Reset tab A form
    setActiveTab('fields');
    setChangeStatus(false);
    setStatus('active');
    setChangeCat(false);
    setAddCategoryId('');
    setIsFeatured('noChange');
    setIsNew('noChange');
    setIsBestSeller('noChange');
    setChangePrice(false);
    setPriceMode('set');
    setPriceValue('');
    setChangeInventory(false);
    setInventoryMode('set');
    setInventoryValue('');

    // Fetch categories
    apiGet<{ categories: Category[] }>(`/api/v1/stores/${storeId}/categories`).then(({ data }) => {
      if (data?.categories) setCategories(data.categories);
    });
  }, [isOpen, storeId]);

  useEffect(() => {
    if (!isOpen || variantProductsToLoad.length === 0) return;
    setLoadingVariants(true);
    setVariantProducts([]);
    setVariantEdits({});

    Promise.all(
      variantProductsToLoad.map(p =>
        apiGet<{ variants: Variant[] }>(`/api/v1/stores/${storeId}/products/${p.id}/variants`).then(
          ({ data }) => ({
            id: p.id,
            name: p.name,
            nameAr: p.nameAr,
            variants: data?.variants ?? [],
          })
        )
      )
    )
      .then(results => {
        setVariantProducts(results);
        const edits: Record<string, { inventory: string; price: string }> = {};
        for (const prod of results) {
          for (const v of prod.variants) {
            edits[v.id] = {
              // Clamp display to 0: existing negative values (from pre-fix
              // backorder decrements) should not confuse the merchant.
              inventory: String(Math.max(0, v.inventory)),
              // An inheriting variant (price null) shows an EMPTY field, not
              // 0.000 — saving 0.000 would pin it to a zero override price.
              price: variantPriceToField(v.price),
            };
          }
        }
        setVariantEdits(edits);
      })
      .finally(() => setLoadingVariants(false));
  }, [isOpen, storeId, variantProductsToLoad.map(p => p.id).join(',')]);

  // ── handlers ────────────────────────────────────────────────────────────

  async function handleApplyFields() {
    // Guard: "Add to category" is checked but no category was picked. Silently
    // dropping `addCategoryId` here would let the other checked fields save
    // while still showing a success toast — hiding the fact the category
    // change never happened.
    if (changeCat && !addCategoryId) {
      toastError(t('massEdit.toast.errorTitle'), t('massEdit.toast.categoryRequired'));
      return;
    }

    const fields: Record<string, unknown> = {};

    if (changeStatus) fields.status = status;
    if (changeCat && addCategoryId) fields.addCategoryId = addCategoryId;
    if (isFeatured !== 'noChange') fields.isFeatured = isFeatured === 'on';
    if (isNew !== 'noChange') fields.isNew = isNew === 'on';
    if (isBestSeller !== 'noChange') fields.isBestSeller = isBestSeller === 'on';

    if (changePrice && priceValue !== '') {
      const v = parseFloat(priceValue);
      if (!isNaN(v)) {
        fields.price = {
          mode: priceMode,
          // For 'set' mode convert EGP → piastres; for adjustPct send the raw percent
          value: priceMode === 'set' ? majorToMinor(priceValue) : v,
        };
      }
    }

    if (changeInventory && inventoryValue !== '') {
      const v = parseInt(inventoryValue, 10);
      if (!isNaN(v)) {
        fields.inventory = { mode: inventoryMode, value: v };
      }
    }

    if (Object.keys(fields).length === 0 && goldSwitch === '') {
      toastError(t('massEdit.toast.errorTitle'), t('massEdit.toast.noChangesSelected'));
      return;
    }

    setApplying(true);
    try {
      if (goldSwitch !== '') {
        const gold = await apiPost<{
          switched: string[];
          skipped: { id: string; reason: string }[];
        }>(`/api/v1/stores/${storeId}/gold-rates/bulk/pricing-mode`, {
          productIds: selectedProducts.map(p => p.id),
          mode: goldSwitch,
        });
        if (gold.error) {
          toastError(t('massEdit.toast.errorTitle'), tGold('failed'));
          return;
        }
        const skippedCount = gold.data?.skipped.length ?? 0;
        if (Object.keys(fields).length === 0) {
          toastSuccess(
            t('massEdit.toast.successTitle'),
            tGold('done', { count: gold.data?.switched.length ?? 0 }) +
              (skippedCount > 0 ? ` ${tGold('skipped', { count: skippedCount })}` : '')
          );
          onSuccess();
          onClose();
          return;
        }
      }
      const { data, error } = await apiPost<{ updated: number; skippedVariantProducts: number }>(
        `/api/v1/stores/${storeId}/products/bulk-update`,
        {
          productIds: selectedProducts.map(p => p.id),
          fields,
        }
      );

      if (error || !data) {
        toastError(t('massEdit.toast.errorTitle'), t('massEdit.toast.errorDescription'));
        return;
      }

      let desc = t('massEdit.toast.successDescription', { updated: String(data.updated) });
      if (data.skippedVariantProducts > 0) {
        desc +=
          ' ' +
          t('massEdit.toast.skippedDescription', { skipped: String(data.skippedVariantProducts) });
      }
      toastSuccess(t('massEdit.toast.successTitle'), desc);
      onSuccess();
      onClose();
    } finally {
      setApplying(false);
    }
  }

  async function handleSaveVariants() {
    setSavingVariants(true);
    const allVariantUpdates: Array<{
      productId: string;
      variantId: string;
      price: number | null;
      inventory: number;
    }> = [];

    for (const prod of variantProducts) {
      for (const v of prod.variants) {
        const edit = variantEdits[v.id];
        if (!edit) continue;
        allVariantUpdates.push({
          productId: prod.id,
          variantId: v.id,
          // Empty = keep inheriting the product price (null override).
          price: variantFieldToPrice(edit.price),
          inventory: Math.max(0, parseInt(edit.inventory, 10) || 0),
        });
      }
    }

    try {
      const results = await Promise.allSettled(
        allVariantUpdates.map(u =>
          apiPut(`/api/v1/stores/${storeId}/products/${u.productId}/variants/${u.variantId}`, {
            price: u.price,
            inventory: u.inventory,
          })
        )
      );

      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        toastError(
          t('massEdit.toast.variantErrorTitle'),
          t('massEdit.toast.variantErrorDescription')
        );
      } else {
        toastSuccess(
          t('massEdit.toast.variantSuccessTitle'),
          t('massEdit.toast.variantSuccessDescription')
        );
        onSuccess();
        onClose();
      }
    } finally {
      setSavingVariants(false);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────

  const modalTitle = t('massEdit.title', { count: String(selectedProducts.length) });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={modalTitle}>
      {/* Tabs */}
      <div className="flex border-b border-border mb-4">
        <Button
          onClick={() => setActiveTab('fields')}
          variant={activeTab === 'fields' ? 'soft' : 'ghost'}
        >
          {t('massEdit.tabFields')}
        </Button>
        <Button
          onClick={() => setActiveTab('variants')}
          variant={activeTab === 'variants' ? 'soft' : 'ghost'}
        >
          {t('massEdit.tabVariants')}
        </Button>
      </div>

      {/* ── TAB A: Fields ──────────────────────────────────────────────── */}
      {activeTab === 'fields' && (
        <div className="space-y-4">
          {/* Status */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={changeStatus}
                onChange={e => setChangeStatus(e.target.checked)}
                className="rounded border-border"
              />
              {t('massEdit.status')}
            </label>
            {changeStatus && (
              <select
                value={status}
                onChange={e => setStatus(e.target.value as typeof status)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="active">{t('status.active')}</option>
                <option value="draft">{t('status.draft')}</option>
                <option value="archived">{t('status.archived')}</option>
              </select>
            )}
          </div>

          {/* Add to category */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={changeCat}
                onChange={e => setChangeCat(e.target.checked)}
                className="rounded border-border"
              />
              {t('massEdit.addToCategory')}
            </label>
            {changeCat && (
              <select
                value={addCategoryId}
                onChange={e => setAddCategoryId(e.target.value)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">{t('massEdit.selectCategory')}</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>
                    {locale === 'ar' && c.nameAr ? c.nameAr : c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Curated flags */}
          <div className="space-y-2">
            <TristateSelect
              value={isFeatured}
              onChange={setIsFeatured}
              label={t('massEdit.isFeatured')}
              t={t}
            />
            <TristateSelect value={isNew} onChange={setIsNew} label={t('massEdit.isNew')} t={t} />
            <TristateSelect
              value={isBestSeller}
              onChange={setIsBestSeller}
              label={t('massEdit.isBestSeller')}
              t={t}
            />
          </div>

          {/* Price */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={changePrice}
                onChange={e => setChangePrice(e.target.checked)}
                className="rounded border-border"
              />
              {t('massEdit.price')}
              <span className="text-xs text-muted-foreground">{t('massEdit.simpleOnly')}</span>
            </label>
            {changePrice && (
              <div className="space-y-2 ms-6">
                <select
                  value={priceMode}
                  onChange={e => setPriceMode(e.target.value as PriceMode)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="set">{t('massEdit.priceMode.set')}</option>
                  <option value="adjustPct">{t('massEdit.priceMode.adjustPct')}</option>
                </select>
                <input
                  type="number"
                  step={priceMode === 'set' ? '0.01' : '0.1'}
                  placeholder={
                    priceMode === 'set' ? t('massEdit.priceValue') : t('massEdit.pricePct')
                  }
                  value={priceValue}
                  onChange={e => setPriceValue(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            )}
          </div>

          {/* Gold-rate pricing */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {tGold('title')}
              <select
                value={goldSwitch}
                onChange={e => setGoldSwitch(e.target.value as '' | 'fixed' | 'gold_rate')}
                className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">{t('massEdit.noChange')}</option>
                <option value="gold_rate">{tGold('toGold')}</option>
                <option value="fixed">{tGold('toFixed')}</option>
              </select>
            </label>
          </div>

          {/* Inventory */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={changeInventory}
                onChange={e => setChangeInventory(e.target.checked)}
                className="rounded border-border"
              />
              {t('massEdit.inventory')}
              <span className="text-xs text-muted-foreground">{t('massEdit.simpleOnly')}</span>
            </label>
            {changeInventory && (
              <div className="space-y-2 ms-6">
                <select
                  value={inventoryMode}
                  onChange={e => setInventoryMode(e.target.value as InventoryMode)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="set">{t('massEdit.inventoryMode.set')}</option>
                  <option value="adjust">{t('massEdit.inventoryMode.adjust')}</option>
                </select>
                <input
                  type="number"
                  step="1"
                  placeholder={t('massEdit.inventoryValue')}
                  value={inventoryValue}
                  onChange={e => setInventoryValue(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={onClose} disabled={applying}>
              {t('massEdit.cancel')}
            </Button>
            <Button onClick={handleApplyFields} disabled={applying}>
              {applying ? t('massEdit.applying') : t('massEdit.apply')}
            </Button>
          </div>
        </div>
      )}

      {/* ── TAB B: Variants ────────────────────────────────────────────── */}
      {activeTab === 'variants' && (
        <div className="space-y-4">
          {variantSelectedProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('massEdit.noVariantProducts')}</p>
          ) : (
            <>
              {simpleSelectedProducts.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('massEdit.simpleProductsNote', {
                    count: String(simpleSelectedProducts.length),
                  })}
                </p>
              )}
              {isCapped && (
                <p className="text-xs text-warning-ink">
                  {t('massEdit.variantCap', { cap: String(VARIANT_LOAD_CAP) })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('massEdit.variantProductsNote', {
                  count: String(Math.min(variantSelectedProducts.length, VARIANT_LOAD_CAP)),
                })}
              </p>

              {loadingVariants ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-10 w-full force-skeleton rounded-md" />
                  ))}
                </div>
              ) : (
                <div className="max-h-[50vh] overflow-y-auto overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {t('massEdit.variantGridProduct')}
                        </th>
                        <th className="px-3 py-2 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {t('massEdit.variantGridVariant')}
                        </th>
                        <th className="px-3 py-2 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground w-24">
                          {t('massEdit.variantGridInventory')}
                        </th>
                        <th className="px-3 py-2 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground w-28">
                          {t('massEdit.variantGridPrice')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {variantProducts.map(prod =>
                        prod.variants.map((v, vi) => {
                          const edit = variantEdits[v.id] ?? {
                            inventory: '0',
                            price: '',
                          };
                          return (
                            <tr key={v.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-2 text-foreground font-medium">
                                {vi === 0 ? prod.name : ''}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">{v.title}</td>
                              <td className="px-3 py-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={edit.inventory}
                                  onChange={e =>
                                    setVariantEdits(prev => ({
                                      ...prev,
                                      [v.id]: { ...prev[v.id], inventory: e.target.value },
                                    }))
                                  }
                                  className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={edit.price}
                                  onChange={e =>
                                    setVariantEdits(prev => ({
                                      ...prev,
                                      [v.id]: { ...prev[v.id], price: e.target.value },
                                    }))
                                  }
                                  className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={onClose} disabled={savingVariants}>
                  {t('massEdit.cancel')}
                </Button>
                <Button onClick={handleSaveVariants} disabled={savingVariants || loadingVariants}>
                  {savingVariants ? t('massEdit.variantSaving') : t('massEdit.variantSaveAll')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
