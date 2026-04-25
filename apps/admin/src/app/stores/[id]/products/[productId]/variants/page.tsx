'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../../../lib/api';
import { formatPrice } from '../../../../../../lib/format';
import { OptionsPanel } from './_components/OptionsPanel';
import { VariantsTable } from './_components/VariantsTable';
import { AddOptionModal } from './_components/AddOptionModal';
import { AddValueModal } from './_components/AddValueModal';
import { EditVariantModal } from './_components/EditVariantModal';
import type { Option, Variant, ProductInfo, VariantFormState } from './_components/types';

const EMPTY_VARIANT_FORM: VariantFormState = {
  sku: '',
  barcode: '',
  price: '',
  compareAtPrice: '',
  costPrice: '',
  inventory: '',
  weight: '',
};

export default function ProductVariantsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const t = useT('products.variants');
  const tSummary = useT('products.variants.summary');

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

      if (!apiError) {
        setShowAddOption(false);
        setNewOptionName('');
        setNewOptionNameAr('');
        setNewOptionValues('');
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to add option:', error);
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
      sku: variant.sku || '',
      barcode: variant.barcode || '',
      price: variant.price?.toString() || '',
      compareAtPrice: variant.compareAtPrice?.toString() || '',
      costPrice: variant.costPrice?.toString() || '',
      inventory: variant.inventory.toString(),
      weight: variant.weight?.toString() || '',
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
        <Button variant="outline" onClick={() => router.push(`/stores/${storeId}/products`)}>
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          {t('backToProducts')}
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
        />
      )}
    </AdminLayout>
  );
}
