'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Modal, useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useAuth } from '../../../../../lib/auth';
import { apiGet, apiDelete } from '../../../../../lib/api';
import { ProductInfoSections, ProductSidebar } from './_components/ProductInfoSections';
import { Product3dModelCard } from './_components/Product3dModelCard';

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
  /** Variant-aware stock total from the API (variant sum for variant products, else `inventory`). */
  totalInventory?: number;
  hasVariants?: boolean;
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
  const t = useT('products.detail');
  const tStatus = useT('products.detail.status');
  const tActions = useT('products.detail.actions');
  const tDelete = useT('products.detail.deleteModal');
  const tToasts = useT('products.detail.toasts');

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track whether the failure was specifically a 404 so we can render a
  // dedicated "this product no longer exists" view with a clear CTA instead
  // of a generic "Failed to load" placeholder. Merchants occasionally land
  // here from a stale browser tab or back-navigation after a delete.
  const [notFound, setNotFound] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  useEffect(() => {
    async function fetchProduct() {
      if (!isAuthenticated || !storeId || !productId) return;

      try {
        setLoading(true);
        setNotFound(false);
        const { data, error: apiError } = await apiGet<{ product: Product }>(
          `/api/v1/stores/${storeId}/products/${productId}`
        );

        if (apiError) {
          if (apiError.status === 404) {
            setNotFound(true);
            setError(t('notFound'));
          } else {
            setError(t('loadFailed'));
          }
          return;
        }

        setProduct(data?.product || null);
      } catch {
        setError(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    }

    fetchProduct();
  }, [productId, storeId, isAuthenticated, t]);

  const handleDelete = async () => {
    if (!product || !isAuthenticated) return;

    try {
      setDeleting(true);
      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${product.id}`
      );

      if (!deleteError) {
        toastSuccess(
          tToasts('deletedTitle'),
          tToasts('deletedDescription', { name: product.name })
        );
        router.push(`/stores/${storeId}/products`);
      } else {
        toastError(tToasts('deleteFailedTitle'), tToasts('deleteFailedDescription'));
        setError(t('loadFailed'));
      }
    } catch {
      toastError(tToasts('deleteFailedTitle'), tToasts('deleteFailedDescription'));
      setError(t('loadFailed'));
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <Badge variant="default" className="bg-success/10 text-success-ink">
            {tStatus('active')}
          </Badge>
        );
      case 'draft':
        return <Badge variant="secondary">{tStatus('draft')}</Badge>;
      case 'archived':
        return <Badge variant="destructive">{tStatus('archived')}</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <AdminLayout title={t('loading')} subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !product) {
    // For a confirmed 404 we show a dedicated "no longer exists" view with
    // an obvious CTA back to the catalogue. For other failures (5xx, network)
    // we expose a Retry button so the merchant doesn't have to refresh the
    // whole page or guess what went wrong.
    return (
      <AdminLayout title={t('notFoundTitle')} subtitle="">
        <div className="rounded-xl border bg-card p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <svg
              className="h-6 w-6 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={
                  notFound
                    ? 'M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                    : 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
                }
              />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {notFound ? t('notFoundTitle') : error || t('loadFailed')}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">{t('notFoundBody')}</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button onClick={() => router.push(`/stores/${storeId}/products`)}>
              {tActions('backToProducts')}
            </Button>
            {!notFound && (
              <Button variant="outline" onClick={() => router.refresh()}>
                {tActions('retry')}
              </Button>
            )}
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={product.name}
      subtitle={t('subtitle', {
        sku: product.sku || t('fallbackSku'),
        storeName: product.store?.name || t('fallbackStore'),
      })}
      actions={
        // `flex-wrap` so all four buttons always render — at narrow
        // desktop widths or on the mobile-actions row this used to
        // push "Recommendations" / "Delete" off-screen with no
        // affordance to find them. Wrapping is uglier on tablets but
        // never hides actions.
        <div className="flex flex-wrap gap-2">
          <Link href={`/stores/${storeId}/products/${product.id}/edit`}>
            <Button variant="outline" size="sm">
              {tActions('edit')}
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/products/${product.id}/variants`}>
            <Button variant="outline" size="sm">
              {tActions('manageVariants')}
            </Button>
          </Link>
          <Link href={`/stores/${storeId}/products/${product.id}/recommendations`}>
            <Button variant="outline" size="sm">
              {tActions('recommendations')}
            </Button>
          </Link>
          <Button variant="destructive" size="sm" onClick={() => setIsDeleteModalOpen(true)}>
            {tActions('delete')}
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <ProductInfoSections
            product={product}
            statusBadge={getStatusBadge(product.status)}
            fallbackSku={t('fallbackSku')}
          />
          <Product3dModelCard storeId={storeId} productId={product.id} />
        </div>

        <div className="space-y-6">
          <ProductSidebar product={product} />
        </div>
      </div>

      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title={tDelete('title')}
      >
        <p className="text-sm text-muted-foreground">
          {tDelete('messageBefore')} <strong>{product.name}</strong>
          {tDelete('messageAfter')}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)} disabled={deleting}>
            {tDelete('cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? tDelete('deleting') : tDelete('confirm')}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
