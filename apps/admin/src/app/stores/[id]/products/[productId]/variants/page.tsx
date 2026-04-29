'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../../../lib/api';
import { formatPrice } from '../../../../../../lib/format';
import { OptionsPanel } from './_components/OptionsPanel';
import { VariantsTable } from './_components/VariantsTable';
import { AddOptionModal } from './_components/AddOptionModal';
import { AddValueModal } from './_components/AddValueModal';
import { EditVariantModal } from './_components/EditVariantModal';
import { WeightScaleCard } from './_components/WeightScaleCard';
import type { Option, Variant, ProductInfo, VariantFormState } from './_components/types';

const EMPTY_VARIANT_FORM: VariantFormState = {
  sku: '',
  barcode: '',
  price: '',
  compareAtPrice: '',
  costPrice: '',
  inventory: '',
  weight: '',
  imageUrl: '',
};

export default function ProductVariantsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const t = useT('products.variants');
  const tSummary = useT('products.variants.summary');
  const { success: toastSuccess, error: toastError } = useToast();

  /**
   * Best-effort SKU auto-generator for new variants. Builds
   * `<parentSku>-<slug(variant.title)>` so a merchant who already
   * has a parent SKU like `WJ-12` and a variant titled "Medium" gets
   * `WJ-12-MEDIUM` for free. Returns the existing SKU when the
   * merchant has already typed one — never overrides explicit input.
   */
  function autoSkuFor(variant: Variant): string {
    if (variant.sku && variant.sku.trim()) return variant.sku;
    const parent = product?.sku?.trim();
    const slug = variant.title
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) return parent ?? '';
    return parent ? `${parent}-${slug}` : slug;
  }

  const [product, setProduct] = useState<ProductInfo | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showAddOption, setShowAddOption] = useState(false);
  const [showAddValue, setShowAddValue] = useState<string | null>(null);
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null);

  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionNameAr, setNewOptionNameAr] = useState('');
  const [newOptionValues, setNewOptionValues] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newValueAr, setNewValueAr] = useState('');

  const [variantForm, setVariantForm] = useState<VariantFormState>(EMPTY_VARIANT_FORM);

  const fetchVariants = useCallback(async () => {
    try {
      const { data } = await apiGet<{
        product: ProductInfo;
        options: Option[];
        variants: Variant[];
      }>(`/api/v1/stores/${storeId}/products/${productId}/variants`);

      if (data) {
        setProduct(data.product);
        setOptions(data.options);
        setVariants(data.variants);
      }
    } catch (error) {
      console.error('Failed to fetch variants:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, productId]);

  useEffect(() => {
    fetchVariants();
  }, [fetchVariants]);

  async function handleAddOption() {
    if (!newOptionName.trim() || !newOptionValues.trim()) return;

    const values = newOptionValues
      .split(',')
      .map(v => ({ value: v.trim() }))
      .filter(v => v.value);

    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/products/${productId}/options`,
        {
          name: newOptionName,
          nameAr: newOptionNameAr || undefined,
          values,
        }
      );

      if (apiError) {
        // Surface the API's error so the merchant sees what's wrong.
        // Most common case: DUPLICATE_OPTION (the option name already
        // exists on this product) — silently swallowing the 400 left
        // the merchant retrying the same name with no feedback.
        toastError('Could not add option', apiError.message);
        return;
      }
      setShowAddOption(false);
      setNewOptionName('');
      setNewOptionNameAr('');
      setNewOptionValues('');
      fetchVariants();
    } catch (error) {
      console.error('Failed to add option:', error);
      toastError('Could not add option', 'Please try again.');
    }
  }

  async function handleDeleteOption(optionId: string) {
    try {
      await apiDelete(`/api/v1/stores/${storeId}/products/${productId}/options/${optionId}`);
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete option:', error);
    }
  }

  async function handleAddValue(optionId: string) {
    if (!newValue.trim()) return;

    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/products/${productId}/options/${optionId}/values`,
        {
          value: newValue,
          valueAr: newValueAr || undefined,
        }
      );

      if (!apiError) {
        setShowAddValue(null);
        setNewValue('');
        setNewValueAr('');
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to add value:', error);
    }
  }

  async function handleDeleteValue(valueId: string) {
    try {
      await apiDelete(`/api/v1/stores/${storeId}/products/${productId}/option-values/${valueId}`);
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete value:', error);
    }
  }

  async function handleGenerateVariants() {
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/products/${productId}/variants/generate`
      );

      if (!apiError) {
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to generate variants:', error);
    }
  }

  async function handleUpdateVariant() {
    if (!editingVariant) return;

    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/products/${productId}/variants/${editingVariant.id}`,
        {
          sku: variantForm.sku || null,
          barcode: variantForm.barcode || null,
          price: variantForm.price ? parseInt(variantForm.price) : null,
          compareAtPrice: variantForm.compareAtPrice ? parseInt(variantForm.compareAtPrice) : null,
          costPrice: variantForm.costPrice ? parseInt(variantForm.costPrice) : null,
          inventory: parseInt(variantForm.inventory) || 0,
          weight: variantForm.weight ? parseFloat(variantForm.weight) : null,
          // Empty string ⇒ explicit clear (null). A populated string is the
          // R2 URL returned from ImageUpload — passed through as-is so the
          // storefront can preview it when this variant is selected.
          imageUrl: variantForm.imageUrl || null,
        }
      );

      if (!apiError) {
        setEditingVariant(null);
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to update variant:', error);
    }
  }

  /**
   * Broadcast a single field's value to every other variant on this
   * product. Triggered from the EditVariantModal "Apply to all" link
   * next to price / compareAtPrice / costPrice. Used when every variant
   * has the same compare-at price (one discount across the line) or the
   * same cost — saves the merchant from editing each variant by hand.
   *
   * Confirms first because this overwrites any per-variant values.
   */
  async function applyFieldToAllVariants(
    field: 'price' | 'compareAtPrice' | 'costPrice',
    value: string
  ) {
    if (!editingVariant) return;
    const fils = parseInt(value);
    if (!Number.isFinite(fils)) return;
    const others = variants.filter(v => v.id !== editingVariant.id);
    if (others.length === 0) return;

    const fieldLabel =
      field === 'price' ? 'Price' : field === 'compareAtPrice' ? 'Compare-at price' : 'Cost';
    const ok = window.confirm(
      `Apply ${fieldLabel} = ${(fils / 1000).toFixed(3)} KWD to all ${others.length} other variants? This will overwrite their current ${fieldLabel.toLowerCase()}.`
    );
    if (!ok) return;

    let failed = 0;
    await Promise.all(
      others.map(async v => {
        const { error } = await apiPut(
          `/api/v1/stores/${storeId}/products/${productId}/variants/${v.id}`,
          { [field]: fils }
        );
        if (error) failed++;
      })
    );

    if (failed === 0) {
      toastSuccess?.(`${fieldLabel} applied`, `Updated ${others.length} variant(s).`);
    } else {
      toastError(
        'Bulk update partially failed',
        `${others.length - failed} of ${others.length} updated. Refresh to see current state.`
      );
    }
    fetchVariants();
  }

  /**
   * Bulk-set price / compareAtPrice / costPrice on each variant
   * (fired by the weight-scaling card). Each update only carries the
   * fields the merchant chose to scale — empty inputs are skipped, so
   * a merchant can scale price-only OR price+compareAt OR all three
   * without overwriting fields they didn't touch. One PUT per variant
   * in parallel; toast on completion.
   */
  async function handleApplyWeightScale(
    updates: Array<{
      variantId: string;
      price?: number;
      compareAtPrice?: number;
      costPrice?: number;
    }>
  ) {
    if (updates.length === 0) return;
    let failed = 0;
    await Promise.all(
      updates.map(async u => {
        const body: Record<string, number> = {};
        if (typeof u.price === 'number') body.price = u.price;
        if (typeof u.compareAtPrice === 'number') body.compareAtPrice = u.compareAtPrice;
        if (typeof u.costPrice === 'number') body.costPrice = u.costPrice;
        if (Object.keys(body).length === 0) return;
        const { error } = await apiPut(
          `/api/v1/stores/${storeId}/products/${productId}/variants/${u.variantId}`,
          body
        );
        if (error) failed++;
      })
    );
    if (failed === 0) {
      toastSuccess('Variant prices scaled', `Updated ${updates.length} variants.`);
    } else {
      toastError(
        'Bulk update partially failed',
        `${updates.length - failed} of ${updates.length} updated.`
      );
    }
    fetchVariants();
  }

  async function handleDeleteVariant(variantId: string) {
    try {
      await apiDelete(`/api/v1/stores/${storeId}/products/${productId}/variants/${variantId}`);
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete variant:', error);
    }
  }

  function openEditVariant(variant: Variant) {
    setEditingVariant(variant);
    setVariantForm({
      // Auto-fill SKU from parent + variant title when the merchant
      // hasn't set one. They can still override before saving.
      sku: autoSkuFor(variant),
      barcode: variant.barcode || '',
      price: variant.price?.toString() || '',
      compareAtPrice: variant.compareAtPrice?.toString() || '',
      costPrice: variant.costPrice?.toString() || '',
      inventory: variant.inventory.toString(),
      weight: variant.weight?.toString() || '',
      imageUrl: variant.imageUrl || '',
    });
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('loading')} subtitle={t('loadingSubtitle')}>
        <div className="animate-pulse space-y-6">
          <div className="h-24 bg-muted rounded-xl" />
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </AdminLayout>
    );
  }

  if (!product) {
    return (
      <AdminLayout title={t('notFoundTitle')} subtitle={t('notFoundSubtitle')}>
        <div className="text-center py-12">
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/products`)}
            className="text-primary hover:underline"
          >
            {t('backToProducts')}
          </button>
        </div>
      </AdminLayout>
    );
  }

  const totalVariantInventory = variants.reduce((sum, v) => sum + v.inventory, 0);

  return (
    <AdminLayout
      title={t('title', { productName: product.name })}
      subtitle={t('subtitle')}
      actions={
        <Button
          variant="outline"
          onClick={() => router.push(`/stores/${storeId}/products/${productId}`)}
        >
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          {t('backToProduct')}
        </Button>
      }
    >
      <div className="rounded-xl border bg-card p-6 shadow-sm mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-foreground">{product.name}</h2>
            {product.nameAr && (
              <p className="text-sm text-muted-foreground" lang="ar" dir="rtl">
                {product.nameAr}
              </p>
            )}
            <p className="text-sm text-muted-foreground mt-1">
              {tSummary('basePrice', { price: formatPrice(product.price) })}
            </p>
          </div>
          <div className="text-end">
            <p className="text-sm text-muted-foreground">{tSummary('totalVariantStock')}</p>
            <p className="text-2xl font-bold text-foreground">{totalVariantInventory}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <OptionsPanel
          options={options}
          onAddOption={() => setShowAddOption(true)}
          onDeleteOption={handleDeleteOption}
          onDeleteValue={handleDeleteValue}
          onAddValue={id => setShowAddValue(id)}
          onGenerateVariants={handleGenerateVariants}
        />

        <WeightScaleCard options={options} variants={variants} onApply={handleApplyWeightScale} />

        <VariantsTable
          variants={variants}
          onEdit={openEditVariant}
          onDelete={handleDeleteVariant}
        />
      </div>

      {showAddOption && (
        <AddOptionModal
          name={newOptionName}
          nameAr={newOptionNameAr}
          values={newOptionValues}
          onNameChange={setNewOptionName}
          onNameArChange={setNewOptionNameAr}
          onValuesChange={setNewOptionValues}
          onCancel={() => setShowAddOption(false)}
          onSubmit={handleAddOption}
        />
      )}

      {showAddValue && (
        <AddValueModal
          value={newValue}
          valueAr={newValueAr}
          onValueChange={setNewValue}
          onValueArChange={setNewValueAr}
          onCancel={() => setShowAddValue(null)}
          onSubmit={() => handleAddValue(showAddValue)}
        />
      )}

      {editingVariant && (
        <EditVariantModal
          variant={editingVariant}
          form={variantForm}
          onChange={setVariantForm}
          onCancel={() => setEditingVariant(null)}
          onSubmit={handleUpdateVariant}
          siblingCount={Math.max(0, variants.length - 1)}
          onApplyToAll={applyFieldToAllVariants}
        />
      )}
    </AdminLayout>
  );
}
