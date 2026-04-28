'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Textarea } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../../../components/ImageUpload';
import { useAuth } from '../../../../../../lib/auth';
import { apiGet, apiPut } from '../../../../../../lib/api';
import { EditSidebar } from './_components/EditSidebar';

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
  inventory: number;
  status: string;
  isFeatured: boolean;
  isNew: boolean;
  isBestSeller: boolean;
  categories: { categoryId: string; category: { id: string; name: string } }[];
  images: { id: string; url: string; alt?: string; position: number }[];
  store: { id: string; name: string; slug: string };
}

interface Category {
  id: string;
  name: string;
}

export default function EditProductPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const t = useT('products.edit');
  const tSections = useT('products.edit.sections');
  const tFields = useT('products.edit.fields');
  const tStatusOptions = useT('products.edit.statusOptions');

  const [product, setProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguish a 404 from a transient load failure so the empty-state below
  // can show a "this product no longer exists" copy + back CTA instead of a
  // generic error.
  const [notFound, setNotFound] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    nameAr: '',
    description: '',
    descriptionAr: '',
    price: '',
    compareAtPrice: '',
    // Cost-of-goods. Used for profit reporting (price - costPrice = margin)
    // and snapshotted onto OrderItem at sale time. Stored in fils on the
    // server, displayed/edited as KWD in the form.
    costPrice: '',
    sku: '',
    inventory: '',
    status: 'draft',
    isFeatured: false,
    isNew: false,
    isBestSeller: false,
    category: '',
  });

  const statuses = useMemo(
    () => [
      { value: 'draft', label: tStatusOptions('draft') },
      { value: 'active', label: tStatusOptions('active') },
      { value: 'archived', label: tStatusOptions('archived') },
    ],
    [tStatusOptions]
  );

  useEffect(() => {
    async function fetchProductAndCategories() {
      if (!isAuthenticated || !storeId || !productId) return;

      try {
        setLoading(true);
        setNotFound(false);

        const [productResult, categoriesResult] = await Promise.all([
          apiGet<{ product?: Product } & Product>(
            `/api/v1/stores/${storeId}/products/${productId}`
          ),
          apiGet<{ categories: Category[] }>(`/api/v1/stores/${storeId}/categories`),
        ]);

        if (categoriesResult.data?.categories) {
          setCategories(categoriesResult.data.categories);
        } else {
          setCategories([]);
        }

        const { data, error: apiError } = productResult;

        if (apiError) {
          if (apiError.status === 404) {
            setNotFound(true);
            setError(t('notFound'));
          } else {
            setError(t('loadFailed'));
          }
          return;
        }

        const p = data?.product || data;
        if (!p) {
          setError(t('loadFailed'));
          return;
        }
        setProduct(p);

        if (p.images?.length) {
          setImages(
            [...p.images]
              .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
              .map((img: { url: string }) => img.url)
          );
        }

        setFormData({
          name: p.name || '',
          nameAr: p.nameAr || '',
          description: p.description || '',
          descriptionAr: p.descriptionAr || '',
          price: p.price ? (p.price / 1000).toFixed(3) : '',
          compareAtPrice: p.compareAtPrice ? (p.compareAtPrice / 1000).toFixed(3) : '',
          costPrice: p.costPrice ? (p.costPrice / 1000).toFixed(3) : '',
          sku: p.sku || '',
          inventory: String(p.inventory ?? 0),
          status: p.status || 'draft',
          isFeatured: p.isFeatured || false,
          isNew: p.isNew || false,
          isBestSeller: p.isBestSeller || false,
          category: p.categories?.[0]?.categoryId || p.categories?.[0]?.category?.id || '',
        });
      } catch {
        setError(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    }

    fetchProductAndCategories();
  }, [productId, storeId, isAuthenticated, t]);

  const updateField = (field: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;

    setError(null);
    setSaving(true);

    try {
      const priceInFils = Math.round(parseFloat(formData.price) * 1000);
      const compareAtPriceInFils = formData.compareAtPrice
        ? Math.round(parseFloat(formData.compareAtPrice) * 1000)
        : undefined;
      const costPriceInFils = formData.costPrice
        ? Math.round(parseFloat(formData.costPrice) * 1000)
        : null;

      const body: Record<string, unknown> = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        description: formData.description || undefined,
        descriptionAr: formData.descriptionAr || undefined,
        price: priceInFils,
        compareAtPrice: compareAtPriceInFils,
        costPrice: costPriceInFils,
        sku: formData.sku || undefined,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        status: formData.status,
        isFeatured: formData.isFeatured,
        isNew: formData.isNew,
        isBestSeller: formData.isBestSeller,
        images: images.map((url, i) => ({ url, position: i })),
      };

      if (formData.category) {
        body.categories = [formData.category];
      } else {
        body.categories = [];
      }

      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/products/${product.id}`,
        body
      );

      if (apiError) {
        setError(apiError.message);
        return;
      }

      router.push(`/stores/${storeId}/products/${productId}`);
    } catch {
      setError(t('updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = [
    { value: '', label: tFields('noCategory') },
    ...categories.map(c => ({ value: c.id, label: c.name })),
  ];

  if (loading) {
    return (
      <AdminLayout title={t('loading')} subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  if (error && !product) {
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
          <h3 className="mt-4 text-lg font-medium text-foreground">{error}</h3>
          {notFound && <p className="mt-2 text-sm text-muted-foreground">{t('notFoundBody')}</p>}
          <Button className="mt-6" onClick={() => router.push(`/stores/${storeId}/products`)}>
            {t('backToProducts')}
          </Button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title', { name: product?.name || t('fallbackTitle') })}
      subtitle={t('subtitle', { storeName: product?.store?.name || t('fallbackStore') })}
    >
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-6 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {tSections('basicInformation')}
              </h2>
              <div className="space-y-4">
                <Input
                  label={tFields('name')}
                  value={formData.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={tFields('namePlaceholder')}
                  required
                />
                <Input
                  label={tFields('nameAr')}
                  value={formData.nameAr}
                  onChange={e => updateField('nameAr', e.target.value)}
                  placeholder={tFields('nameArPlaceholder')}
                  lang="ar"
                  dir="rtl"
                />
                <Textarea
                  label={tFields('description')}
                  value={formData.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={tFields('descriptionPlaceholder')}
                  rows={4}
                />
                <Textarea
                  label={tFields('descriptionAr')}
                  value={formData.descriptionAr}
                  onChange={e => updateField('descriptionAr', e.target.value)}
                  placeholder={tFields('descriptionArPlaceholder')}
                  rows={4}
                  lang="ar"
                  dir="rtl"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <div className="mb-4 flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-foreground">{tSections('media')}</h2>
                <p className="text-xs text-muted-foreground">{tFields('mediaSizeHint')}</p>
              </div>
              <MultiImageUpload
                values={images}
                onChange={setImages}
                folder="products"
                label={tFields('mediaHint')}
                max={10}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('pricing')}</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <Input
                  label={tFields('price')}
                  type="number"
                  step="0.001"
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder={tFields('pricePlaceholder')}
                  required
                />
                <Input
                  label={tFields('compareAtPrice')}
                  type="number"
                  step="0.001"
                  value={formData.compareAtPrice}
                  onChange={e => updateField('compareAtPrice', e.target.value)}
                  placeholder={tFields('pricePlaceholder')}
                />
                <Input
                  label={tFields('costPrice')}
                  type="number"
                  step="0.001"
                  value={formData.costPrice}
                  onChange={e => updateField('costPrice', e.target.value)}
                  placeholder={tFields('pricePlaceholder')}
                />
              </div>
              {/* Live profit hint — only renders when both price and cost
                  are filled. Helps the merchant see margin while pricing
                  the product instead of guessing afterwards. */}
              {(() => {
                const sellPrice = parseFloat(formData.price);
                const cost = parseFloat(formData.costPrice);
                if (!Number.isFinite(sellPrice) || !Number.isFinite(cost) || sellPrice <= 0)
                  return null;
                const margin = sellPrice - cost;
                const marginPct = (margin / sellPrice) * 100;
                const profitable = margin > 0;
                return (
                  <p className={`mt-3 text-sm ${profitable ? 'text-success' : 'text-destructive'}`}>
                    {tFields('profitLabel')}{' '}
                    <span className="font-semibold">
                      {margin.toFixed(3)} KWD ({marginPct.toFixed(1)}%)
                    </span>
                  </p>
                );
              })()}
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {tSections('inventory')}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={tFields('sku')}
                  value={formData.sku}
                  onChange={e => updateField('sku', e.target.value)}
                  placeholder={tFields('skuPlaceholder')}
                />
                <Input
                  label={tFields('quantity')}
                  type="number"
                  value={formData.inventory}
                  onChange={e => updateField('inventory', e.target.value)}
                  placeholder={tFields('quantityPlaceholder')}
                />
              </div>
            </div>
          </div>

          <EditSidebar
            status={formData.status}
            onStatusChange={value => updateField('status', value)}
            statuses={statuses}
            category={formData.category}
            onCategoryChange={value => updateField('category', value)}
            categoryOptions={categoryOptions}
            isFeatured={formData.isFeatured}
            onFeaturedChange={value => updateField('isFeatured', value)}
            isNew={formData.isNew}
            onIsNewChange={value => updateField('isNew', value)}
            isBestSeller={formData.isBestSeller}
            onIsBestSellerChange={value => updateField('isBestSeller', value)}
            saving={saving}
            onCancel={() => router.push(`/stores/${storeId}/products/${productId}`)}
          />
        </div>
      </form>
    </AdminLayout>
  );
}
