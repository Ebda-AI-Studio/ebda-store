'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useAuth } from '../../../../lib/auth';
import { apiGet, apiDelete } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';
import { ProductsToolbar } from './_components/ProductsToolbar';
import { ProductFilters } from './_components/ProductFilters';
import { ProductsTable } from './_components/ProductsTable';
import { ProductsPagination } from './_components/ProductsPagination';
import { DeleteProductModal } from './_components/DeleteProductModal';
import { MassEditModal } from './_components/MassEditModal';
import { ProductsLoadingSkeleton } from './_components/ProductsLoadingSkeleton';
import type { Product, Pagination, StatusFilter } from './_components/types';

export default function StoreProductsPage() {
  const params = useParams();
  const { isAuthenticated } = useAuth();
  const storeId = params.id as string;
  const t = useT('products.list');
  const router = useRouter();
  const searchParams = useSearchParams();

  const { store } = useCurrentStore(isAuthenticated ? storeId : null);

  // Filter/search/page state is mirrored into the URL query string so that
  // navigating into a product and hitting Back restores the exact same view
  // (search term, category, status, page) instead of resetting to the top.
  const initialStatus = ((): StatusFilter => {
    const s = searchParams.get('status');
    return s === 'active' || s === 'draft' || s === 'archived' || s === 'all' ? s : 'active';
  })();

  // Per-page preference is persisted per store so the user's choice survives
  // navigation. Falls back to 25 when nothing is stored.
  const limitStorageKey = storeId ? `products.perPage.${storeId}` : null;
  const initialLimit = (() => {
    if (typeof window === 'undefined' || !limitStorageKey) return 25;
    const stored = window.localStorage.getItem(limitStorageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return [10, 25, 50, 100, 200, 500].includes(parsed) ? parsed : 25;
  })();

  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [limit, setLimit] = useState(initialLimit);
  const [loading, setLoading] = useState(true);
  // `search` holds the already-debounced term — SearchInput owns the debounce.
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [categoryFilter, setCategoryFilter] = useState<string>(searchParams.get('category') ?? '');
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get('page') ?? '1', 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  });
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Selection persists ACROSS searches/filters/pages so the merchant can build a
  // set from several different searches. We keep the full Product object (not just
  // the id) so a product selected under one search stays editable after the list
  // re-filters away from it — `selectedProducts` (from the map) feeds the mass
  // editor directly, not `products.filter(...)` which only sees the current page.
  const [selectedMap, setSelectedMap] = useState<Map<string, Product>>(new Map());
  const selectedIds = useMemo(() => new Set(selectedMap.keys()), [selectedMap]);
  const [isMassEditOpen, setIsMassEditOpen] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  const fetchProducts = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      setLoading(true);
      const queryParams = new URLSearchParams({
        page: page.toString(),
        limit: String(limit),
      });
      if (statusFilter !== 'all') queryParams.append('status', statusFilter);
      if (categoryFilter) queryParams.append('category', categoryFilter);
      if (search) queryParams.append('search', search);

      // API returns `{ products, meta }`; we used to read `data.pagination`,
      // which was always undefined and hid the pagination control entirely.
      // Accept both field names so the catalogue paginates correctly.
      const { data } = await apiGet<{
        products: Product[];
        meta?: Pagination;
        pagination?: Pagination;
      }>(`/api/v1/stores/${storeId}/products?${queryParams}`);

      if (data) {
        setProducts(data.products || []);
        setPagination(data.meta ?? data.pagination ?? null);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, storeId, page, limit, statusFilter, categoryFilter, search]);

  // Load the category list once (for the category filter dropdown).
  useEffect(() => {
    if (!isAuthenticated || !storeId) return;
    apiGet<{ categories: { id: string; name: string }[] }>(`/api/v1/stores/${storeId}/categories`)
      .then(({ data }) => setCategories(data?.categories ?? []))
      .catch(() => setCategories([]));
  }, [isAuthenticated, storeId]);

  // Mirror the current filter state into the URL (replace, no history spam) so
  // Back from a product restores the same search + category + status + page.
  useEffect(() => {
    const qp = new URLSearchParams();
    if (search) qp.set('q', search);
    if (statusFilter !== 'active') qp.set('status', statusFilter);
    if (categoryFilter) qp.set('category', categoryFilter);
    if (page > 1) qp.set('page', String(page));
    const qs = qp.toString();
    router.replace(`/stores/${storeId}/products${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [router, storeId, search, statusFilter, categoryFilter, page]);

  // Fetch products whenever any of the list-query inputs change. fetchProducts
  // is memoized on [isAuthenticated, storeId, page, statusFilter, debouncedSearch]
  // so a single effect covers the original two useEffects.
  useEffect(() => {
    if (!isAuthenticated) return;
    fetchProducts();
  }, [isAuthenticated, fetchProducts]);

  // NOTE: filter/search/page changes do NOT clear the selection — it accumulates
  // across searches by design. Selection clears only on the explicit "Clear"
  // button or after a successful mass edit.
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleStatusFilterChange = (status: StatusFilter) => {
    setStatusFilter(status);
    setPage(1);
  };

  const handleToggleSelect = (id: string) => {
    setSelectedMap(prev => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const p = products.find(x => x.id === id);
        if (p) next.set(id, p);
      }
      return next;
    });
  };

  const handleToggleSelectAll = (ids: string[]) => {
    setSelectedMap(prev => {
      const allSelected = ids.length > 0 && ids.every(id => prev.has(id));
      const next = new Map(prev);
      if (allSelected) {
        ids.forEach(id => next.delete(id));
      } else {
        ids.forEach(id => {
          const p = products.find(x => x.id === id);
          if (p) next.set(id, p);
        });
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedMap(new Map());

  const handleCategoryFilterChange = (categoryId: string) => {
    setCategoryFilter(categoryId);
    setPage(1);
  };

  const categoryOptions = useMemo(
    () => categories.map(c => ({ value: c.id, label: c.name })),
    [categories]
  );

  const handleDelete = async () => {
    if (!productToDelete || !isAuthenticated) return;

    try {
      setDeleting(true);
      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${productToDelete.id}`
      );

      if (!deleteError) {
        toastSuccess(
          t('toast.deletedTitle'),
          t('toast.deletedDescription', { name: productToDelete.name })
        );
        fetchProducts();
      } else {
        toastError(t('toast.deleteFailedTitle'), t('toast.deleteFailedDescription'));
      }
    } catch (error) {
      console.error('Error deleting product:', error);
      toastError(t('toast.deleteFailedTitle'), t('toast.deleteFailedDescription'));
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
      setProductToDelete(null);
    }
  };

  if (loading && !store) {
    return <ProductsLoadingSkeleton />;
  }

  const storeName = store?.name ?? t('fallbackStore');
  const hasActiveFilters = Boolean(search) || statusFilter !== 'all' || Boolean(categoryFilter);

  return (
    <AdminLayout
      title={t('title', { storeName })}
      subtitle={t('subtitle', { storeName: store?.name ?? t('fallbackThisStore') })}
      actions={<ProductsToolbar storeId={storeId} />}
    >
      <ProductFilters
        search={search}
        onSearchChange={handleSearchChange}
        statusFilter={statusFilter}
        onStatusFilterChange={handleStatusFilterChange}
        categoryFilter={categoryFilter}
        categoryOptions={categoryOptions}
        onCategoryFilterChange={handleCategoryFilterChange}
      />

      <ProductsTable
        storeId={storeId}
        products={products}
        loading={loading}
        hasActiveFilters={hasActiveFilters}
        onRequestDelete={product => {
          setProductToDelete(product);
          setIsDeleteModalOpen(true);
        }}
        selectedIds={selectedIds}
        onToggleSelect={handleToggleSelect}
        onToggleSelectAll={handleToggleSelectAll}
      />

      {pagination && (
        <ProductsPagination
          pagination={pagination}
          page={page}
          onPageChange={next => {
            setPage(next);
          }}
          onLimitChange={next => {
            if (limitStorageKey) window.localStorage.setItem(limitStorageKey, String(next));
            setLimit(next);
            setPage(1);
          }}
        />
      )}

      <DeleteProductModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDelete}
        product={productToDelete}
        deleting={deleting}
      />

      {/* Sticky selection action bar — shown whenever ≥1 product selected */}
      {selectedMap.size > 0 && (
        <div className="fixed bottom-6 start-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xl">
          <span className="text-sm font-medium text-foreground whitespace-nowrap">
            {t('selectionBar.selected').replace('{count}', String(selectedMap.size))}
          </span>
          <button
            onClick={() => setIsMassEditOpen(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('selectionBar.massEdit')}
          </button>
          <button
            onClick={clearSelection}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            {t('selectionBar.clear')}
          </button>
        </div>
      )}

      <MassEditModal
        isOpen={isMassEditOpen}
        onClose={() => setIsMassEditOpen(false)}
        storeId={storeId}
        selectedProducts={Array.from(selectedMap.values())}
        onSuccess={() => {
          clearSelection();
          fetchProducts();
        }}
      />
    </AdminLayout>
  );
}
