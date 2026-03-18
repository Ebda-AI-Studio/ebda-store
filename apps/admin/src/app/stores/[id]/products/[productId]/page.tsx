'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Modal, useToast } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useAuth } from '../../../../../lib/auth';
import { apiGet, apiDelete } from '../../../../../lib/api';
import { formatPrice } from '../../../../../lib/format';

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
  categories: { categoryId: string; category: { id: string; name: string } }[];
  images: { id: string; url: string; alt?: string; position: number }[];
  tags: { tagId: string; tag: { id: string; name: string } }[];
  store: { id: string; name: string; slug: string };
  createdAt: string;
  updatedAt: string;
}

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  useEffect(() => {
    async function fetchProduct() {
      if (!isAuthenticated || !storeId || !productId) return;

      try {
        setLoading(true);
        const { data, error: apiError } = await apiGet<{ product: Product }>(
          `/api/v1/stores/${storeId}/products/${productId}`
        );

        if (apiError) {
          setError(apiError.status === 404 ? 'Product not found' : 'Failed to load product');
          return;
        }

        setProduct(data?.product || null);
      } catch {
        setError('Failed to load product');
      } finally {
        setLoading(false);
      }
    }

    fetchProduct();
  }, [productId, storeId, isAuthenticated]);

  const handleDelete = async () => {
    if (!product || !isAuthenticated) return;

    try {
      setDeleting(true);
      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${product.id}`
      );

      if (!deleteError) {
        toastSuccess('Product deleted', `${product.name} has been deleted.`);
        router.push(`/stores/${storeId}/products`);
      } else {
        toastError('Delete failed', 'Failed to delete the product. Please try again.');
        setError('Failed to delete product');
      }
    } catch {
      toastError('Delete failed', 'Failed to delete the product. Please try again.');
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
        <div className="rounded-xl border bg-card p-8 text-center">
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {error || 'Product not found'}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
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
          <Link href={`/stores/${storeId}/products/${product.id}/edit`}>
            <Button variant="outline" size="sm">
              Edit
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/products/${product.id}/variants`}>
            <Button variant="outline" size="sm">
              Manage Variants
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/products/${product.id}/recommendations`}>
            <Button variant="outline" size="sm">
              Recommendations
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
          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Product Details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Name</label>
                <p className="mt-1 text-foreground">{product.name}</p>
              </div>
              {product.nameAr && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Name (Arabic)</label>
                  <p className="mt-1 text-foreground" dir="rtl">
                    {product.nameAr}
                  </p>
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-muted-foreground">Slug</label>
                <p className="mt-1 text-foreground font-mono text-sm">{product.slug}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Status</label>
                <div className="mt-1">{getStatusBadge(product.status)}</div>
              </div>
            </div>
            {product.description && (
              <div className="mt-4">
                <label className="text-sm font-medium text-muted-foreground">Description</label>
                <p className="mt-1 text-gray-700">{product.description}</p>
              </div>
            )}
            {product.descriptionAr && (
              <div className="mt-4">
                <label className="text-sm font-medium text-muted-foreground">
                  Description (Arabic)
                </label>
                <p className="mt-1 text-gray-700" dir="rtl">
                  {product.descriptionAr}
                </p>
              </div>
            )}
          </div>

          {/* Pricing */}
          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Pricing</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Price</label>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatPrice(product.price)}
                </p>
              </div>
              {product.compareAtPrice && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground">
                    Compare at Price
                  </label>
                  <p className="mt-1 text-lg text-muted-foreground line-through">
                    {formatPrice(product.compareAtPrice)}
                  </p>
                </div>
              )}
              {product.costPrice && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Cost Price</label>
                  <p className="mt-1 text-lg text-gray-700">{formatPrice(product.costPrice)}</p>
                </div>
              )}
            </div>
          </div>

          {/* Inventory */}
          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Inventory</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground">SKU</label>
                <p className="mt-1 text-foreground font-mono">{product.sku || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Barcode</label>
                <p className="mt-1 text-foreground font-mono">{product.barcode || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Stock</label>
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
            <div className="rounded-xl border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Images</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {product.images.map(image => (
                  <div
                    key={image.id}
                    className="aspect-square rounded-lg overflow-hidden border bg-muted"
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
            <div className="rounded-xl border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Categories</h2>
              <div className="flex flex-wrap gap-2">
                {product.categories.map(c => (
                  <Badge key={c.categoryId || c.category?.id} variant="secondary">
                    {c.category?.name || c.categoryId}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {product.tags && product.tags.length > 0 && (
            <div className="rounded-xl border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {product.tags.map(t => (
                  <Badge key={t.tagId || t.tag?.id} variant="outline">
                    {t.tag?.name || t.tagId}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Product Flags</h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Featured</span>
                <Badge variant={product.isFeatured ? 'default' : 'secondary'}>
                  {product.isFeatured ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">New Arrival</span>
                <Badge variant={product.isNew ? 'default' : 'secondary'}>
                  {product.isNew ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Track Inventory</span>
                <Badge variant={product.trackInventory ? 'default' : 'secondary'}>
                  {product.trackInventory ? 'Yes' : 'No'}
                </Badge>
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Timestamps</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="text-foreground">
                  {new Date(product.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Updated</span>
                <span className="text-foreground">
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
        <p className="text-sm text-muted-foreground">
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
