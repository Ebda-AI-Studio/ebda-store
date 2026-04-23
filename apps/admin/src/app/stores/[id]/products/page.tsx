'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useAuth } from '../../../../lib/auth';
import { apiGet, apiDelete } from '../../../../lib/api';
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue';
import { useT } from '@/i18n/useT';
import { ProductsToolbar } from './_components/ProductsToolbar';
import { ProductFilters } from './_components/ProductFilters';
import { ProductsTable } from './_components/ProductsTable';
import { ProductsPagination } from './_components/ProductsPagination';
import { DeleteProductModal } from './_components/DeleteProductModal';
import { ProductsLoadingSkeleton } from './_components/ProductsLoadingSkeleton';
import type { Product, Store, Pagination, StatusFilter } from './_components/types';

export default function StoreProductsPage() {
  const params = useParams();
  const { isAuthenticated } = useAuth();
  const storeId = params.id as string;
  const t = useT('products.list');

  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchStore();
    fetchProducts();
  }, [storeId, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchProducts();
  }, [page, statusFilter, debouncedSearch]);

  async function fetchStore() {
    if (!isAuthenticated) return;
    try {
      const { data } = await apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`);
      if (data) {
        setStore(data.store);
      }
    } catch (error) {
      console.error('Error fetching store:', error);
    }
  }

  async function fetchProducts() {
    if (!isAuthenticated) return;

    try {
      setLoading(true);
      const queryParams = new URLSearchParams({
        page: page.toString(),
        limit: '20',
      });
      if (statusFilter !== 'all') queryParams.append('status', statusFilter);
      if (debouncedSearch) queryParams.append('search', debouncedSearch);

      const { data } = await apiGet<{ products: Product[]; pagination: Pagination }>(
        `/api/v1/stores/${storeId}/products?${queryParams}`
      );

      if (data) {
        setProducts(data.products || []);
        setPagination(data.pagination);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchProducts();
  };

  const handleStatusFilterChange = (status: StatusFilter) => {
    setStatusFilter(status);
    setPage(1);
  };

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
  const hasActiveFilters = Boolean(search) || statusFilter !== 'all';

  return (
    <AdminLayout
      title={t('title', { storeName })}
      subtitle={t('subtitle', { storeName: store?.name ?? t('fallbackThisStore') })}
      actions={<ProductsToolbar storeId={storeId} />}
    >
      <ProductFilters
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={handleStatusFilterChange}
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
        <ProductsPagination pagination={pagination} page={page} onPageChange={setPage} />
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
