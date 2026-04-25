'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../../components/ImageUpload';
import { useAuth } from '../../../../../lib/auth';
import { apiGet, apiPost } from '../../../../../lib/api';
import { useT } from '@/i18n/useT';

interface Category {
  id: string;
  name: string;
}

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams();
  const storeId = params?.id as string;
  const { isAuthenticated } = useAuth();
  const t = useT('products.new');

  const statuses = [
    { value: 'draft', label: t('statusOptions.draft') },
    { value: 'active', label: t('statusOptions.active') },
    { value: 'archived', label: t('statusOptions.archived') },
  ];
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [images, setImages] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    nameAr: '',
    description: '',
    descriptionAr: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    inventory: '',
    category: '',
    status: 'draft',
  });

  // Fetch categories for this store
  useEffect(() => {
    if (!storeId || !isAuthenticated) return;

    async function fetchCategories() {
      try {
        const { data } = await apiGet<{ categories: Category[] }>(
          `/api/v1/stores/${storeId}/categories`
        );
        if (data?.categories) {
          setCategories(data.categories);
        }
      } catch {
        setCategories([]);
      }
    }

    fetchCategories();
  }, [storeId, isAuthenticated]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const priceInFils = Math.round(parseFloat(formData.price) * 1000);
      const compareAtPriceInFils = formData.compareAtPrice
        ? Math.round(parseFloat(formData.compareAtPrice) * 1000)
        : undefined;

      const body: Record<string, unknown> = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        description: formData.description || undefined,
        descriptionAr: formData.descriptionAr || undefined,
        price: priceInFils,
        compareAtPrice: compareAtPriceInFils,
        sku: formData.sku || undefined,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        status: formData.status,
        images: images.map(url => ({ url })),
      };

      if (formData.category) {
        body.categories = [formData.category];
      }

      const { data, error: apiError } = await apiPost(`/api/v1/stores/${storeId}/products`, body);

      if (apiError) {
        setError(apiError.message);
        return;
      }

      if (data) {
        router.push(`/stores/${storeId}/products`);
      }
    } catch {
      setError(t('errors.createFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const categoryOptions = [
    { value: '', label: t('fields.noCategory') },
    ...categories.map(c => ({ value: c.id, label: c.name })),
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-6 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {t('sections.basicInformation')}
              </h2>
              <div className="space-y-4">
                <Input
                  label={t('fields.name')}
                  value={formData.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('fields.namePlaceholder')}
                  required
                />
                <Input
                  label={t('fields.nameAr')}
                  value={formData.nameAr}
                  onChange={e => updateField('nameAr', e.target.value)}
                  placeholder={t('fields.nameArPlaceholder')}
                  lang="ar"
                  dir="rtl"
                />
                <Textarea
                  label={t('fields.description')}
                  value={formData.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={t('fields.descriptionPlaceholder')}
                  rows={4}
                />
                <Textarea
                  label={t('fields.descriptionAr')}
                  value={formData.descriptionAr}
                  onChange={e => updateField('descriptionAr', e.target.value)}
                  placeholder={t('fields.descriptionArPlaceholder')}
                  rows={4}
                  lang="ar"
                  dir="rtl"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">{t('sections.media')}</h2>
              <MultiImageUpload
                values={images}
                onChange={setImages}
                folder="products"
                label={t('fields.mediaHint')}
                max={10}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {t('sections.pricing')}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('fields.price')}
                  type="number"
                  step="0.001"
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder={t('fields.pricePlaceholder')}
                  required
                />
                <Input
                  label={t('fields.compareAtPrice')}
                  type="number"
                  step="0.001"
                  value={formData.compareAtPrice}
                  onChange={e => updateField('compareAtPrice', e.target.value)}
                  placeholder={t('fields.pricePlaceholder')}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('fields.pricingHint')}</p>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {t('sections.inventory')}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('fields.sku')}
                  value={formData.sku}
                  onChange={e => updateField('sku', e.target.value)}
                  placeholder={t('fields.skuPlaceholder')}
                />
                <Input
                  label={t('fields.quantity')}
                  type="number"
                  value={formData.inventory}
                  onChange={e => updateField('inventory', e.target.value)}
                  placeholder={t('fields.quantityPlaceholder')}
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">{t('sections.status')}</h2>
              <Select
                label={t('fields.productStatus')}
                value={formData.status}
                onChange={e => updateField('status', e.target.value)}
                options={statuses}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {t('sections.organization')}
              </h2>
              <Select
                label={t('fields.category')}
                value={formData.category}
                onChange={e => updateField('category', e.target.value)}
                options={categoryOptions}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <div className="space-y-3">
                <Button type="submit" className="w-full" isLoading={isLoading}>
                  {t('actions.create')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => router.push(`/stores/${storeId}/products`)}
                >
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </AdminLayout>
  );
}
