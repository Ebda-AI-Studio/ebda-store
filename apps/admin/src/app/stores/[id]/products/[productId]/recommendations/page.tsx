'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Input, useToast } from '@force/ui';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useAuth } from '../../../../../../lib/auth';
import { apiGet, apiPut } from '../../../../../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductSummary {
  id: string;
  name: string;
  price: number;
  images: { url: string }[];
  status: string;
}

interface ProductRelation {
  targetProductId: string;
  type: 'cross_sell' | 'upsell';
  position: number;
  targetProduct?: ProductSummary;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CROSS_SELL = 8;
const MAX_UPSELL = 4;

// ─── Product Search Component ─────────────────────────────────────────────────

interface ProductSearchProps {
  storeId: string;
  label: string;
  placeholder: string;
  onSelect: (product: ProductSummary) => void;
  excludeIds: string[];
  disabled?: boolean;
}

function ProductSearch({
  storeId,
  label,
  placeholder,
  onSelect,
  excludeIds,
  disabled,
}: ProductSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setOpen(false);
        return;
      }
      setSearching(true);
      try {
        const { data } = await apiGet<{ products: ProductSummary[] }>(
          `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=10`
        );
        const filtered = (data?.products ?? []).filter(p => !excludeIds.includes(p.id));
        setResults(filtered);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [storeId, excludeIds]
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (product: ProductSummary) => {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      <div className="relative">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {searching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg max-h-60 overflow-y-auto">
          {results.map(product => (
            <button
              key={product.id}
              type="button"
              onClick={() => handleSelect(product)}
              className="flex w-full items-center gap-3 px-3 py-2 hover:bg-muted text-left"
            >
              <div className="h-8 w-8 rounded-md bg-muted overflow-hidden flex-shrink-0">
                {product.images?.[0] ? (
                  <img
                    src={product.images[0].url}
                    alt={product.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                )}
              </div>
              <span className="text-sm text-foreground truncate">{product.name}</span>
            </button>
          ))}
        </div>
      )}

      {open && !searching && query.trim() && results.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg px-3 py-4 text-center text-sm text-muted-foreground">
          No products found
        </div>
      )}
    </div>
  );
}

// ─── Selected Product Card ────────────────────────────────────────────────────

interface SelectedProductCardProps {
  product: ProductSummary;
  onRemove: () => void;
}

function SelectedProductCard({ product, onRemove }: SelectedProductCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="h-10 w-10 rounded-md bg-muted overflow-hidden flex-shrink-0">
        {product.images?.[0] ? (
          <img
            src={product.images[0].url}
            alt={product.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-muted-foreground">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}
      </div>
      <span className="flex-1 text-sm font-medium text-foreground truncate">{product.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
        aria-label={`Remove ${product.name}`}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductRecommendationsPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const productId = params?.productId as string;

  const [productName, setProductName] = useState<string>('');
  const [crossSell, setCrossSell] = useState<ProductSummary[]>([]);
  const [upsell, setUpsell] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();

  // Load existing relations + product name on mount
  useEffect(() => {
    if (!isAuthenticated || !storeId || !productId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // Fetch product name
      const { data: productData } = await apiGet<{ product?: { name: string }; name?: string }>(
        `/api/v1/stores/${storeId}/products/${productId}`
      );
      if (!cancelled) {
        const name =
          productData?.product?.name ?? (productData as { name?: string })?.name ?? 'Product';
        setProductName(name);
      }

      // Fetch existing relations
      const { data: relData, error: relError } = await apiGet<{
        relations?: ProductRelation[];
      }>(`/api/v1/stores/${storeId}/products/${productId}/relations`);

      if (cancelled) return;

      if (relError) {
        // 404 is fine — no relations yet
        if (relError.status !== 404) {
          setError('Failed to load existing recommendations.');
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
      toastError('Save failed', apiError.message);
      setError(apiError.message);
    } else {
      toastSuccess('Saved', 'Recommendations saved successfully.');
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

  // All already-selected IDs (to exclude from searches) — memoized to keep
  // ProductSearch's useCallback dependency stable across unrelated re-renders.
  const allSelectedIds = useMemo(
    () => [productId, ...crossSell.map(p => p.id), ...upsell.map(p => p.id)],
    [productId, crossSell, upsell]
  );

  if (loading) {
    return (
      <AdminLayout title="Loading..." subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={`Recommendations: ${productName}`}
      subtitle="Manage cross-sell and upsell product relationships"
      actions={
        <div className="flex gap-2">
          <Button onClick={handleSave} isLoading={saving}>
            Save Recommendations
          </Button>
          <Link href={`/stores/${storeId}/products/${productId}/edit`}>
            <Button variant="outline">Back to Edit</Button>
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
        {/* Cross-sell Section */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Frequently Bought Together</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Products that customers commonly buy alongside this one.
              </p>
            </div>
            <span className="flex-shrink-0 text-sm text-muted-foreground">
              {crossSell.length} / {MAX_CROSS_SELL}
            </span>
          </div>

          <ProductSearch
            storeId={storeId}
            label="Search products"
            placeholder="Type to search products..."
            onSelect={addCrossSell}
            excludeIds={allSelectedIds}
            disabled={crossSell.length >= MAX_CROSS_SELL}
          />

          {crossSell.length >= MAX_CROSS_SELL && (
            <p className="mt-2 text-xs text-amber-600">
              Maximum of {MAX_CROSS_SELL} cross-sell products reached.
            </p>
          )}

          <div className="mt-4 space-y-2">
            {crossSell.length === 0 ? (
              <p className="rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No cross-sell products added yet. Search above to add some.
              </p>
            ) : (
              crossSell.map(product => (
                <SelectedProductCard
                  key={product.id}
                  product={product}
                  onRemove={() => removeCrossSell(product.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Upsell Section */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Upsell Alternatives</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Higher-value products to suggest as alternatives or upgrades.
              </p>
            </div>
            <span className="flex-shrink-0 text-sm text-muted-foreground">
              {upsell.length} / {MAX_UPSELL}
            </span>
          </div>

          <ProductSearch
            storeId={storeId}
            label="Search products"
            placeholder="Type to search products..."
            onSelect={addUpsell}
            excludeIds={allSelectedIds}
            disabled={upsell.length >= MAX_UPSELL}
          />

          {upsell.length >= MAX_UPSELL && (
            <p className="mt-2 text-xs text-amber-600">
              Maximum of {MAX_UPSELL} upsell products reached.
            </p>
          )}

          <div className="mt-4 space-y-2">
            {upsell.length === 0 ? (
              <p className="rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No upsell products added yet. Search above to add some.
              </p>
            ) : (
              upsell.map(product => (
                <SelectedProductCard
                  key={product.id}
                  product={product}
                  onRemove={() => removeUpsell(product.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Bottom save bar */}
      <div className="mt-6 flex justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => router.push(`/stores/${storeId}/products/${productId}/edit`)}
        >
          Cancel
        </Button>
        <Button onClick={handleSave} isLoading={saving}>
          Save Recommendations
        </Button>
      </div>
    </AdminLayout>
  );
}
