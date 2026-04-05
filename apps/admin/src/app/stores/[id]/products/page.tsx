'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Input, Modal, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useAuth } from '../../../../lib/auth';
import { apiGet, apiDelete } from '../../../../lib/api';
import { formatPrice } from '../../../../lib/format';

interface Product {
  id: string;
  name: string;
  nameAr?: string;
  sku: string | null;
  price: number;
  inventory: number;
  status: string;
  images: { url: string }[];
  hasVariants: boolean;
}

interface Store {
  id: string;
  name: string;
  slug: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function StoreProductsPage() {
  const params = useParams();
  const { isAuthenticated } = useAuth();
  const storeId = params.id as string;

  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
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
  }, [page, statusFilter, search]);

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
      if (search) queryParams.append('search', search);

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

  const handleDelete = async () => {
    if (!productToDelete || !isAuthenticated) return;

    try {
      setDeleting(true);
      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${productToDelete.id}`
      );

      if (!deleteError) {
        toastSuccess('Product deleted', `${productToDelete.name} has been deleted.`);
        fetchProducts();
      } else {
        toastError('Delete failed', 'Failed to delete the product. Please try again.');
      }
    } catch (error) {
      console.error('Error deleting product:', error);
      toastError('Delete failed', 'Failed to delete the product. Please try again.');
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
      setProductToDelete(null);
    }
  };

  const getStatusBadge = (status: string) => {
    const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium';
    switch (status) {
      case 'active':
        return (
          <span className={`${base} bg-emerald-50 text-emerald-700`}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        );
      case 'draft':
        return (
          <span className={`${base} bg-amber-50 text-amber-700`}>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Draft
          </span>
        );
      case 'archived':
        return (
          <span className={`${base} bg-muted text-muted-foreground`}>
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            Archived
          </span>
        );
      default:
        return (
          <span className={`${base} bg-muted text-muted-foreground`}>
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
            {status}
          </span>
        );
    }
  };

  if (loading && !store) {
    return (
      <AdminLayout title="Products" subtitle="Loading...">
        <div className="space-y-6">
          {/* Skeleton filters */}
          <div className="flex items-center justify-between">
            <div className="h-9 w-64 force-skeleton rounded-lg" />
            <div className="h-9 w-32 force-skeleton rounded-lg" />
          </div>
          {/* Skeleton table */}
          <div className="rounded-xl border bg-card overflow-hidden overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b">
                <tr>
                  {['Product', 'SKU', 'Price', 'Inventory', 'Status', 'Actions'].map(h => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-sm font-medium text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg force-skeleton" />
                        <div className="h-4 w-36 force-skeleton" />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-20 force-skeleton" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-16 force-skeleton" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-10 force-skeleton" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-6 w-16 rounded-full force-skeleton" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <div className="h-8 w-14 rounded-lg force-skeleton" />
                        <div className="h-8 w-14 rounded-lg force-skeleton" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={`Products - ${store?.name || 'Store'}`}
      subtitle={`Manage products for ${store?.name || 'this store'}`}
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/products/new`}>
            <Button size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Product
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/bulk`}>
            <Button variant="outline" size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              Bulk Import
            </Button>
          </Link>
          <Link href={`/stores/${storeId}`}>
            <Button variant="outline" size="sm">
              Back to Store
            </Button>
          </Link>
        </div>
      }
    >
      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <form onSubmit={handleSearch}>
              <Input
                placeholder="Search products..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-64 pl-9"
              />
            </form>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
          {['all', 'active', 'draft', 'archived'].map(s => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-all duration-200 ${
                statusFilter === s
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      {/* Products Table */}
      <div className="rounded-xl border bg-card overflow-hidden overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted border-b">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Product
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">SKU</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Price
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Inventory
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg force-skeleton" />
                      <div className="h-4 w-36 force-skeleton" />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-20 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-16 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-10 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-6 w-16 rounded-full force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <div className="h-8 w-14 rounded-lg force-skeleton" />
                      <div className="h-8 w-14 rounded-lg force-skeleton" />
                    </div>
                  </td>
                </tr>
              ))
            ) : products.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center">
                  <div className="force-empty-state py-0">
                    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted mx-auto">
                      <svg
                        className="h-8 w-8 text-muted-foreground"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                    <p className="font-semibold text-foreground">No products found</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {search || statusFilter !== 'all'
                        ? 'Try adjusting your search or filters.'
                        : 'Add your first product to get started.'}
                    </p>
                    {!search && statusFilter === 'all' && (
                      <Link href={`/stores/${storeId}/products/new`} className="mt-4 inline-block">
                        <Button size="sm">Add Product</Button>
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              products.map(product => (
                <tr
                  key={product.id}
                  className="hover:bg-muted/50 transition-colors duration-150 cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-muted overflow-hidden">
                        {product.images?.[0] ? (
                          <img
                            src={product.images[0].url}
                            alt={product.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                            <svg
                              className="h-5 w-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
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
                      <div>
                        <p className="font-medium text-foreground">{product.name}</p>
                        {product.hasVariants && (
                          <span className="text-xs text-blue-600">Has variants</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground font-mono">
                    {product.sku || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{formatPrice(product.price)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-sm font-medium ${
                        product.inventory === 0
                          ? 'text-destructive'
                          : product.inventory < 10
                            ? 'text-yellow-600'
                            : 'text-[hsl(var(--success))]'
                      }`}
                    >
                      {product.inventory}
                    </span>
                  </td>
                  <td className="px-4 py-3">{getStatusBadge(product.status)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {product.hasVariants && (
                        <Link href={`/stores/${storeId}/products/${product.id}/variants`}>
                          <Button variant="outline" size="sm">
                            Variants
                          </Button>
                        </Link>
                      )}
                      <Link href={`/stores/${storeId}/products/${product.id}/edit`}>
                        <Button variant="outline" size="sm">
                          Edit
                        </Button>
                      </Link>
                      <Link href={`/stores/${storeId}/products/${product.id}`}>
                        <Button variant="outline" size="sm">
                          View
                        </Button>
                      </Link>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setProductToDelete(product);
                          setIsDeleteModalOpen(true);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * pagination.limit + 1} to{' '}
            {Math.min(page * pagination.limit, pagination.total)} of {pagination.total} products
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page === pagination.totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Delete Product"
      >
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete <strong>{productToDelete?.name}</strong>? This action
          cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete Product'}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
