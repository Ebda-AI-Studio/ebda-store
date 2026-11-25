'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet } from '../../../../../../lib/api';
import { formatPrice } from '../../../../../../lib/format';
import { SimpleVariantsForm } from './_components/SimpleVariantsForm';
import { OptionSwatchesEditor } from './_components/OptionSwatchesEditor';
import type { Option, Variant, ProductInfo } from './_components/types';

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

  if (isLoading) {
    return (
      <AdminLayout title={t('loading')} subtitle={t('loadingSubtitle')}>
        <div className="animate-pulse space-y-6">
          <div className="h-24 bg-muted rounded-md" />
          <div className="h-64 bg-muted rounded-md" />
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

  // A disabled variant is not stock (#1103) — same rule as the API's
  // effectiveInventory, so this total matches the product list and storefront.
  const totalVariantInventory = variants
    .filter(v => v.isActive !== false)
    .reduce((sum, v) => sum + v.inventory, 0);

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
      <div className="rounded-md border bg-card p-6 shadow-sm mb-6">
        <div className="flex items-center justify-between gap-4">
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

      <SimpleVariantsForm
        storeId={storeId}
        productId={productId}
        product={product}
        options={options}
        variants={variants}
        onSaved={fetchVariants}
      />
      {options.length >= 2 && (
        <OptionSwatchesEditor
          key={options
            .flatMap(o => o.values.map(v => `${v.id}${v.swatchHex ?? ''}${v.swatchImageUrl ?? ''}`))
            .join()}
          storeId={storeId}
          productId={productId}
          options={options}
          onSaved={fetchVariants}
        />
      )}
    </AdminLayout>
  );
}
