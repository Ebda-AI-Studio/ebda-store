'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Modal } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useAuth } from '../../../../../lib/auth';
import { getApiUrl } from '../../../../../lib/api';

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
  tags: { productId: string; tagId: string; tag: { id: string; name: string } }[];
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
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function fetchProduct() {
      if (!token || !storeId || !productId) return;

      try {
        setLoading(true);
        const response = await fetch(
          `${getApiUrl()}/api/v1/stores/${storeId}/products/${productId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response.ok) {
          setError(response.status === 404 ? 'Product not found' : 'Failed to load product');
          return;
        }

        const data = await response.json();
        setProduct(data.data?.product || data.data);
      } catch {
        setError('Failed to load product');
      } finally {
        setLoading(false);
      }
    }

    fetchProduct();
  }, [productId, storeId, token]);

  const handleDelete = async () => {
    if (!product || !token) return;

    try {
      setDeleting(true);
      const response = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/products/${product.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.ok) {
        router.push(`/stores/${storeId}/products`);
      } else {
        setError('Failed to delete product');
      }
    } catch {
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
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !product) {
    return (
      <AdminLayout title="Product Not Found" subtitle="">
        <div className="rounded-xl border bg-white p-8 text-center">
          <h3 className="mt-4 text-lg font-medium text-gray-900">{error || 'Product not found'}</h3>
          <p className="mt-2 text-sm text-gray-500">
            The product you&apos;re looking for doesn&apos;t exist or has been removed.
          </p>
          <Button className="mt-6" onClick={() => router.push(`/stores/${storeId}/products`)}>
            Back to Products
          </Button>
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
          <Link href={`/stores/${storeId}/products/${product.id}/variants`}>
            <Button variant="outline" size="sm">
              Manage Variants
            </Button>
          </Link>
          <Button variant="destructive" size="sm" onClick={() => setIsDeleteModalOpen(true)}>
            Delete
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3">
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
                  <p className="mt-1 text-gray-900" dir="rtl">
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
            {product.descriptionAr && (
              <div className="mt-4">
                <label className="text-sm font-medium text-gray-500">Description (Arabic)</label>
                <p className="mt-1 text-gray-700" dir="rtl">
                  {product.descriptionAr}
                </p>
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

          {product.tags && product.tags.length > 0 && (
            <div className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {product.tags.map(t => (
                  <Badge key={t.tagId || t.tag?.id} variant="outline">
                    {typeof t === 'string' ? t : t.tag?.name || t.tagId}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Flags</h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Featured</span>
                <Badge variant={product.isFeatured ? 'default' : 'secondary'}>
                  {product.isFeatured ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">New Arrival</span>
                <Badge variant={product.isNew ? 'default' : 'secondary'}>
                  {product.isNew ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Track Inventory</span>
                <Badge variant={product.trackInventory ? 'default' : 'secondary'}>
                  {product.trackInventory ? 'Yes' : 'No'}
                </Badge>
              </div>
            </div>
          </div>

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
