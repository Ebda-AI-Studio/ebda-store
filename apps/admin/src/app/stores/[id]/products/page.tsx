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

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleStatusFilterChange = (status: StatusFilter) => {
    setStatusFilter(status);
    setPage(1);
  };

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
      />

      {pagination && (
        <ProductsPagination
          pagination={pagination}
          page={page}
          onPageChange={setPage}
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
    </AdminLayout>
  );
}
