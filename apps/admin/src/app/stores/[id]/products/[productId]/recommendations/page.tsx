'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useAuth } from '../../../../../../lib/auth';
import { apiGet, apiPut } from '../../../../../../lib/api';
import { type ProductSummary } from './_components/ProductSearch';
import { RelationSection } from './_components/RelationSection';

interface ProductRelation {
  targetProductId: string;
  type: 'cross_sell' | 'upsell';
  position: number;
  targetProduct?: ProductSummary;
}

const MAX_CROSS_SELL = 8;
const MAX_UPSELL = 4;

export default function ProductRecommendationsPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const t = useT('products.recommendations');
  const tActions = useT('products.recommendations.actions');
  const tToasts = useT('products.recommendations.toasts');

  const [productName, setProductName] = useState<string>('');
  const [crossSell, setCrossSell] = useState<ProductSummary[]>([]);
  const [upsell, setUpsell] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();

  useEffect(() => {
    if (!isAuthenticated || !storeId || !productId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: productData } = await apiGet<{ product?: { name: string }; name?: string }>(
        `/api/v1/stores/${storeId}/products/${productId}`
      );
      if (!cancelled) {
        const name =
          productData?.product?.name ??
          (productData as { name?: string })?.name ??
          t('fallbackProductName');
        setProductName(name);
      }

      const { data: relData, error: relError } = await apiGet<{
        relations?: ProductRelation[];
      }>(`/api/v1/stores/${storeId}/products/${productId}/relations`);

      if (cancelled) return;

      if (relError) {
        if (relError.status !== 404) {
          setError(t('errors.loadFailed'));
        }
        setLoading(false);
        return;
      }

      const relations = relData?.relations ?? [];

      const cs: ProductSummary[] = relations
        .filter(r => r.type === 'cross_sell')
        .sort((a, b) => a.position - b.position)
        .map(r => r.targetProduct!)
        .filter(Boolean);

      const up: ProductSummary[] = relations
        .filter(r => r.type === 'upsell')
        .sort((a, b) => a.position - b.position)
        .map(r => r.targetProduct!)
        .filter(Boolean);

      setCrossSell(cs);
      setUpsell(up);
      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, storeId, productId, t]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    const relations = [
      ...crossSell.map((p, i) => ({
        targetProductId: p.id,
        type: 'cross_sell' as const,
        position: i,
      })),
      ...upsell.map((p, i) => ({
        targetProductId: p.id,
        type: 'upsell' as const,
        position: i,
      })),
    ];

    const { error: apiError } = await apiPut(
      `/api/v1/stores/${storeId}/products/${productId}/relations`,
      { relations }
    );

    if (apiError) {
      toastError(tToasts('saveFailedTitle'), apiError.message);
      setError(apiError.message);
    } else {
      toastSuccess(tToasts('savedTitle'), tToasts('savedDescription'));
    }

    setSaving(false);
  };

  const addCrossSell = useCallback((product: ProductSummary) => {
    setCrossSell(prev => {
      if (prev.length >= MAX_CROSS_SELL) return prev;
      if (prev.find(p => p.id === product.id)) return prev;
      return [...prev, product];
    });
  }, []);

  const removeCrossSell = useCallback((id: string) => {
    setCrossSell(prev => prev.filter(p => p.id !== id));
  }, []);

  const addUpsell = useCallback((product: ProductSummary) => {
    setUpsell(prev => {
      if (prev.length >= MAX_UPSELL) return prev;
      if (prev.find(p => p.id === product.id)) return prev;
      return [...prev, product];
    });
  }, []);

  const removeUpsell = useCallback((id: string) => {
    setUpsell(prev => prev.filter(p => p.id !== id));
  }, []);

  const allSelectedIds = useMemo(
    () => [productId, ...crossSell.map(p => p.id), ...upsell.map(p => p.id)],
    [productId, crossSell, upsell]
  );

  if (loading) {
    return (
      <AdminLayout title={t('loading')} subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title', { productName })}
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-2">
          <Button onClick={handleSave} isLoading={saving}>
            {tActions('save')}
          </Button>
          <Link href={`/stores/${storeId}/products/${productId}/edit`}>
            <Button variant="outline">{tActions('backToEdit')}</Button>
          </Link>
        </div>
      }
    >
      {error && (
        <div className="mb-6 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <RelationSection
          kind="crossSell"
          storeId={storeId}
          items={crossSell}
          max={MAX_CROSS_SELL}
          excludeIds={allSelectedIds}
          onAdd={addCrossSell}
          onRemove={removeCrossSell}
        />
        <RelationSection
          kind="upsell"
          storeId={storeId}
          items={upsell}
          max={MAX_UPSELL}
          excludeIds={allSelectedIds}
          onAdd={addUpsell}
          onRemove={removeUpsell}
        />
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => router.push(`/stores/${storeId}/products/${productId}/edit`)}
        >
          {tActions('cancel')}
        </Button>
        <Button onClick={handleSave} isLoading={saving}>
          {tActions('save')}
        </Button>
      </div>
    </AdminLayout>
  );
}
