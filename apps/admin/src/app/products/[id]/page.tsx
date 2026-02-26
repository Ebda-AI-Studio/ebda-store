'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Modal } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { useAuth } from '../../../lib/auth';
import { getApiUrl } from '../../../lib/api';

interface Product {
  id: string;
  storeId: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  costPrice?: number;
  sku?: string;
  barcode?: string;
  inventory: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  status: string;
  isFeatured: boolean;
  isNew: boolean;
  weight?: number;
  categories: { id: string; name: string }[];
  images: { id: string; url: string; alt?: string; position: number }[];
  tags: string[];
  store: { id: string; name: string; slug: string };
  createdAt: string;
  updatedAt: string;
}

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(fils / 1000);
}

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { token } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const productId = params.id as string;

  useEffect(() => {
    async function fetchProduct() {
      if (!token) return;

      try {
        setLoading(true);
        // First, we need to find which store this product belongs to
        // Call admin endpoint to get product by ID across all stores
        const response = await fetch(`${getApiUrl()}/api/v1/admin/products/${productId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          if (response.status === 404) {
            setError('Product not found');
          } else {
            setError('Failed to load product');
          }
          return;
        }

        const data = await response.json();
        setProduct(data.data.product);
      } catch (err) {
        console.error('Error fetching product:', err);
        setError('Failed to load product');
      } finally {
        setLoading(false);
      }
    }

    fetchProduct();
  }, [productId, token]);

  const handleDelete = async () => {
    if (!product || !token) return;

    try {
      setDeleting(true);
      const response = await fetch(
        `${getApiUrl()}/api/v1/stores/${product.storeId}/products/${product.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        router.push('/products');
      } else {
        setError('Failed to delete product');
      }
    } catch (err) {
      console.error('Error deleting product:', err);
      setError('Failed to delete product');
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
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

  if (loading) {
    return (
      <AdminLayout title="Loading..." subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }

  if (error || !product) {
    return (
      <AdminLayout title="Product Not Found" subtitle="">
        <div className="rounded-xl border bg-white p-8 text-center">
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
          <h3 className="mt-4 text-lg font-medium text-gray-900">{error || 'Product not found'}</h3>
          <p className="mt-2 text-sm text-gray-500">
            The product you&apos;re looking for doesn&apos;t exist or has been removed.
          </p>
          <Link href="/products">
            <Button className="mt-6">Back to Products</Button>
          </Link>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={product.name}
      subtitle={`SKU: ${product.sku || 'N/A'} • Store: ${product.store?.name || 'Unknown'}`}
      actions={
        <div className="flex gap-2">
          <Link href={`/products/${product.id}/edit`}>
            <Button variant="outline" size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              Edit
            </Button>
          </Link>
          <Link href={`/stores/${product.storeId}/products/${product.id}/variants`}>
            <Button variant="outline" size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 10h16M4 14h16M4 18h16"
                />
              </svg>
              Manage Variants
            </Button>
          </Link>
          <Button variant="destructive" size="sm" onClick={() => setIsDeleteModalOpen(true)}>
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Delete
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Details */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Details</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-gray-500">Name</label>
                <p className="mt-1 text-gray-900">{product.name}</p>
              </div>
              {product.nameAr && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Name (Arabic)</label>
                  <p className="mt-1 text-gray-900 font-arabic" dir="rtl">
                    {product.nameAr}
                  </p>
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-gray-500">Slug</label>
                <p className="mt-1 text-gray-900 font-mono text-sm">{product.slug}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Status</label>
                <div className="mt-1">{getStatusBadge(product.status)}</div>
              </div>
            </div>

            {product.description && (
              <div className="mt-4">
                <label className="text-sm font-medium text-gray-500">Description</label>
                <p className="mt-1 text-gray-700">{product.description}</p>
              </div>
            )}
          </div>

          {/* Pricing */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Pricing</h2>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-gray-500">Price</label>
                <p className="mt-1 text-2xl font-bold text-gray-900">
                  {formatPrice(product.price)}
                </p>
              </div>
              {product.compareAtPrice && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Compare at Price</label>
                  <p className="mt-1 text-lg text-gray-500 line-through">
                    {formatPrice(product.compareAtPrice)}
                  </p>
                </div>
              )}
              {product.costPrice && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Cost Price</label>
                  <p className="mt-1 text-lg text-gray-700">{formatPrice(product.costPrice)}</p>
                </div>
              )}
            </div>
          </div>

          {/* Inventory */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Inventory</h2>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-gray-500">SKU</label>
                <p className="mt-1 text-gray-900 font-mono">{product.sku || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Barcode</label>
                <p className="mt-1 text-gray-900 font-mono">{product.barcode || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Stock</label>
                <p
                  className={`mt-1 text-lg font-semibold ${
                    product.inventory === 0
                      ? 'text-red-600'
                      : product.inventory <= product.lowStockThreshold
                        ? 'text-yellow-600'
                        : 'text-green-600'
                  }`}
                >
                  {product.inventory} in stock
                </p>
              </div>
            </div>
          </div>

          {/* Images */}
          {product.images && product.images.length > 0 && (
            <div className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Images</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {product.images.map(image => (
                  <div
                    key={image.id}
                    className="aspect-square rounded-lg overflow-hidden border bg-gray-50"
                  >
                    <img
                      src={image.url}
                      alt={image.alt || product.name}
                      className="h-full w-full object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Store Info */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Store</h2>
            <Link
              href={`/stores/${product.store.id}`}
              className="flex items-center gap-3 hover:bg-gray-50 -mx-2 px-2 py-2 rounded-lg transition"
            >
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary to-orange-400 flex items-center justify-center text-white font-bold">
                {product.store.name.charAt(0)}
              </div>
              <div>
                <p className="font-medium text-gray-900">{product.store.name}</p>
                <p className="text-sm text-gray-500">{product.store.slug}</p>
              </div>
            </Link>
          </div>

          {/* Categories */}
          {product.categories && product.categories.length > 0 && (
            <div className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Categories</h2>
              <div className="flex flex-wrap gap-2">
                {product.categories.map(category => (
                  <Badge key={category.id} variant="secondary">
                    {category.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {product.tags && product.tags.length > 0 && (
            <div className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {product.tags.map(tag => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Flags */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Flags</h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Featured</span>
                {product.isFeatured ? (
                  <Badge className="bg-yellow-100 text-yellow-700">Yes</Badge>
                ) : (
                  <Badge variant="secondary">No</Badge>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">New Arrival</span>
                {product.isNew ? (
                  <Badge className="bg-blue-100 text-blue-700">Yes</Badge>
                ) : (
                  <Badge variant="secondary">No</Badge>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Track Inventory</span>
                {product.trackInventory ? (
                  <Badge className="bg-green-100 text-green-700">Yes</Badge>
                ) : (
                  <Badge variant="secondary">No</Badge>
                )}
              </div>
            </div>
          </div>

          {/* Timestamps */}
          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Timestamps</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Created</span>
                <span className="text-gray-900">
                  {new Date(product.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Updated</span>
                <span className="text-gray-900">
                  {new Date(product.updatedAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Delete Product"
      >
        <p className="text-sm text-gray-600">
          Are you sure you want to delete <strong>{product.name}</strong>? This action cannot be
          undone.
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
