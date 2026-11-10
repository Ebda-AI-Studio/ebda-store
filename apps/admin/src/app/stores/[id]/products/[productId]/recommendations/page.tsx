'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useAuth } from '../../../../../../lib/auth';
import { apiGet, apiPut } from '../../../../../../lib/api';
import { type ProductSummary } from './_components/ProductSearch';
import { RelationSection } from './_components/RelationSection';
import { AiSuggestionsPanel } from './_components/AiSuggestionsPanel';

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

      // Fetch product + relations in parallel — sequential ones meant
      // a slow /products call delayed the relations render, and any
      // shared cancellation race left the relations state empty.
      const [productResult, relationsResult] = await Promise.all([
        apiGet<{ product?: { name: string }; name?: string }>(
          `/api/v1/stores/${storeId}/products/${productId}`
        ),
        apiGet<{ relations?: ProductRelation[] }>(
          `/api/v1/stores/${storeId}/products/${productId}/relations`
        ),
      ]);

      if (cancelled) return;

      const productData = productResult.data;
      const name =
        productData?.product?.name ??
        (productData as { name?: string } | null)?.name ??
        t('fallbackProductName');
      setProductName(name);

      const { data: relData, error: relError } = relationsResult;

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
    // `t` is stable across renders (next-intl memoizes by namespace) but
    // listing it as a dep would re-run this effect on every render in
    // dev mode where its identity isn't preserved. We deliberately omit
    // it — the load only depends on auth/store/product identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, storeId, productId]);

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

  // Used by AiSuggestionsPanel "Demote all" to strip a batch of ids
  // (the AI-promoted ones) from the manual cross-sell list in one shot
  // instead of re-rendering N times via removeCrossSell.
  const removeManyCrossSell = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setCrossSell(prev => prev.filter(p => !idSet.has(p.id)));
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
        <div className="mb-6 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
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

      {/* AI-generated cross-sell picks from the bulk-ai-recommendations
          sweep — see _components/AiSuggestionsPanel.tsx. The picks are
          stored in `ai_recommendation` (separate from manual
          `product_relations`) and rendered on the storefront as
          "You might also like" when no manual cross-sell exists. */}
      <div className="mt-6">
        <AiSuggestionsPanel
          storeId={storeId}
          productId={productId}
          alreadyInCrossSell={crossSell.map(p => p.id)}
          onPromote={addCrossSell}
          onDemoteAll={removeManyCrossSell}
          maxCrossSell={MAX_CROSS_SELL}
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
