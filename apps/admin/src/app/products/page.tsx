'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button, Input, Badge, Modal } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../lib/auth';
import { getApiUrl } from '../../lib/api';
import { useStore } from '../../contexts/StoreContext';

interface Product {
  id: string;
  storeId: string;
  name: string;
  sku: string | null;
  price: number;
  inventory: number;
  status: string;
  store: { id: string; name: string };
  images: { url: string }[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(fils / 1000);
}

export default function ProductsPage() {
  const { token } = useAuth();
  const { selectedStoreId } = useStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);
  const [isBulkDeleteModalOpen, setIsBulkDeleteModalOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [isBulkStatusModalOpen, setIsBulkStatusModalOpen] = useState(false);
  const [bulkStatusUpdating, setBulkStatusUpdating] = useState(false);
  const [selectedBulkStatus, setSelectedBulkStatus] = useState<string>('active');

  const fetchProducts = useCallback(async () => {
    if (!token) return;

    try {
      setError(null);
      setLoading(true);
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '20',
      });
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (search) params.append('search', search);
      if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);

      const response = await fetch(`${getApiUrl()}/api/v1/admin/products?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setProducts(data.data.products || []);
        setPagination(data.data.pagination);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error?.message || 'Failed to fetch products');
      }
    } catch (error) {
      console.error('Error fetching products:', error);
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [token, page, statusFilter, search, selectedStoreId]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchProducts();
  };

  const filteredProducts = products;

  const toggleSelectAll = () => {
    if (selectedProducts.length === filteredProducts.length) {
      setSelectedProducts([]);
    } else {
      setSelectedProducts(filteredProducts.map(p => p.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedProducts(prev => (prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]));
  };

  const handleDelete = (product: Product) => {
    setProductToDelete(product);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!productToDelete || !token) return;

    try {
      setDeleting(true);
      const response = await fetch(
        `${getApiUrl()}/api/v1/stores/${productToDelete.storeId}/products/${productToDelete.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        setProducts(prev => prev.filter(p => p.id !== productToDelete.id));
        setSelectedProducts(prev => prev.filter(p => p !== productToDelete.id));
      }
    } catch (error) {
      console.error('Error deleting product:', error);
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
      setProductToDelete(null);
    }
  };

  const confirmBulkDelete = async () => {
    if (!token || selectedProducts.length === 0) return;

    try {
      setBulkDeleting(true);

      // Delete each selected product
      const deletePromises = selectedProducts.map(async productId => {
        const product = products.find(p => p.id === productId);
        if (!product) return;

        return fetch(`${getApiUrl()}/api/v1/stores/${product.storeId}/products/${productId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      });

      await Promise.all(deletePromises);

      // Remove deleted products from state
      setProducts(prev => prev.filter(p => !selectedProducts.includes(p.id)));
      setSelectedProducts([]);
    } catch (error) {
      console.error('Error deleting products:', error);
    } finally {
      setBulkDeleting(false);
      setIsBulkDeleteModalOpen(false);
    }
  };

  const confirmBulkStatusUpdate = async () => {
    if (!token || selectedProducts.length === 0) return;

    try {
      setBulkStatusUpdating(true);

      // Update each selected product's status
      const updatePromises = selectedProducts.map(async productId => {
        const product = products.find(p => p.id === productId);
        if (!product) return;

        return fetch(`${getApiUrl()}/api/v1/stores/${product.storeId}/products/${productId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: selectedBulkStatus }),
        });
      });

      await Promise.all(updatePromises);

      // Update status in local state
      setProducts(prev =>
        prev.map(p => (selectedProducts.includes(p.id) ? { ...p, status: selectedBulkStatus } : p))
      );
      setSelectedProducts([]);
    } catch (error) {
      console.error('Error updating products:', error);
    } finally {
      setBulkStatusUpdating(false);
      setIsBulkStatusModalOpen(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <Badge variant="default" className="bg-green-100 text-green-700">
            Active
          </Badge>
        );
      case 'draft':
        return <Badge variant="secondary">Draft</Badge>;
      case 'archived':
        return <Badge variant="destructive">Archived</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getInventoryStatus = (inventory: number) => {
    if (inventory === 0) {
      return <span className="text-red-600">0 in stock</span>;
    }
    if (inventory < 20) {
      return <span className="text-yellow-600">{inventory} in stock</span>;
    }
    return <span className="text-gray-600">{inventory} in stock</span>;
  };

  return (
    <AdminLayout
      title="Products"
      subtitle={pagination ? `${pagination.total} products in your catalog` : 'Loading...'}
      actions={
        <Link href="/products/new">
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
      }
    >
      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {['all', 'active', 'draft', 'archived'].map(status => (
            <button
              key={status}
              onClick={() => {
                setStatusFilter(status);
                setPage(1);
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                statusFilter === status
                  ? 'bg-primary text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border'
              }`}
            >
              {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
        <form onSubmit={handleSearch} className="flex gap-2 w-full sm:w-auto">
          <div className="w-full sm:w-64">
            <Input
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </div>

      {/* Bulk Actions */}
      {selectedProducts.length > 0 && (
        <div className="mb-4 flex items-center gap-4 rounded-xl bg-primary/5 p-3 border border-primary/20">
          <span className="text-sm font-medium text-foreground">
            {selectedProducts.length} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl"
            onClick={() => setIsBulkStatusModalOpen(true)}
          >
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            Change Status
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="rounded-xl"
            onClick={() => setIsBulkDeleteModalOpen(true)}
          >
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Delete Selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelectedProducts([])}
          >
            Clear Selection
          </Button>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <ErrorState title="Failed to load products" message={error} onRetry={fetchProducts} />
      )}

      {/* Loading State */}
      {!error && loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      ) : !error ? (
        <>
          {/* Products Table */}
          <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="w-12 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={
                        selectedProducts.length === filteredProducts.length &&
                        filteredProducts.length > 0
                      }
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Product
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    SKU
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Store
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Price
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Inventory
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {filteredProducts.map(product => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedProducts.includes(product.id)}
                        onChange={() => toggleSelect(product.id)}
                        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.images && product.images.length > 0 ? (
                          <div className="h-10 w-10 rounded-lg overflow-hidden bg-gray-100">
                            <img
                              src={product.images[0].url}
                              alt={product.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary/10 to-orange-100">
                            <svg
                              className="h-5 w-5 text-primary"
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
                        )}
                        <Link
                          href={`/products/${product.id}`}
                          className="font-medium text-gray-900 hover:text-primary"
                        >
                          {product.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono">
                      {product.sku || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/stores/${product.store.id}`}
                        className="text-sm text-gray-600 hover:text-primary"
                      >
                        {product.store.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {formatPrice(product.price)}
                    </td>
                    <td className="px-4 py-3 text-sm">{getInventoryStatus(product.inventory)}</td>
                    <td className="px-4 py-3">{getStatusBadge(product.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/products/${product.id}`}>
                          <Button variant="ghost" size="sm">
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </Button>
                        </Link>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(product)}>
                          <svg
                            className="h-4 w-4 text-red-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredProducts.length === 0 && (
              <div className="py-12 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
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
                <h3 className="mt-4 text-sm font-medium text-gray-900">No products found</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {search
                    ? 'Try adjusting your search criteria.'
                    : 'Get started by adding your first product.'}
                </p>
                <Link href="/products/new">
                  <Button className="mt-4">Add Product</Button>
                </Link>
              </div>
            )}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing {(page - 1) * 20 + 1} to {Math.min(page * 20, pagination.total)} of{' '}
                {pagination.total} products
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
        </>
      ) : null}

      {/* Delete Confirmation Modal */}
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
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setIsDeleteModalOpen(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="rounded-xl"
            onClick={confirmDelete}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </Modal>

      {/* Bulk Delete Confirmation Modal */}
      <Modal
        isOpen={isBulkDeleteModalOpen}
        onClose={() => setIsBulkDeleteModalOpen(false)}
        title="Delete Selected Products"
      >
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete <strong>{selectedProducts.length} products</strong>? This
          action cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setIsBulkDeleteModalOpen(false)}
            disabled={bulkDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="rounded-xl"
            onClick={confirmBulkDelete}
            disabled={bulkDeleting}
          >
            {bulkDeleting ? 'Deleting...' : `Delete ${selectedProducts.length} Products`}
          </Button>
        </div>
      </Modal>

      {/* Bulk Status Update Modal */}
      <Modal
        isOpen={isBulkStatusModalOpen}
        onClose={() => setIsBulkStatusModalOpen(false)}
        title="Change Status"
      >
        <p className="text-sm text-muted-foreground mb-4">
          Select a new status for <strong>{selectedProducts.length} selected products</strong>:
        </p>
        <select
          value={selectedBulkStatus}
          onChange={e => setSelectedBulkStatus(e.target.value)}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setIsBulkStatusModalOpen(false)}
            disabled={bulkStatusUpdating}
          >
            Cancel
          </Button>
          <Button
            className="rounded-xl"
            onClick={confirmBulkStatusUpdate}
            disabled={bulkStatusUpdating}
          >
            {bulkStatusUpdating ? 'Updating...' : 'Update Status'}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
