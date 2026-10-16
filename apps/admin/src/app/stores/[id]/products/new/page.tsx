'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { SearchTermsField } from '@/components/SearchTermsField';
import { Button, Input, Textarea, Select } from '@ebda/ui';
import {
  recommendedSizeTextForTemplate,
  type TemplateId,
  applyDiscount,
  computeDiscountAmount,
  formatPrice,
  PRODUCT_BADGE_LABEL_MAX_LENGTH,
  roundToMinor,
} from '@ebda/shared';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../../components/ImageUpload';
import { useAuth } from '../../../../../lib/auth';
import { apiGet, apiPost } from '../../../../../lib/api';
import { productTextFields } from '../../../../../lib/product-payload';
import { sanitizeReturnTo } from '../../../../../lib/return-to';
import { useT } from '@/i18n/useT';

type DiscountType = 'none' | 'percentage' | 'fixed';

interface Category {
  id: string;
  name: string;
}

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const storeId = params?.id as string;
  const { isAuthenticated } = useAuth();
  const t = useT('products.new');

  // Plain products-list URL — the fallback whenever `returnTo` is absent or
  // doesn't point back into this store's product list (open-redirect guard).
  const plainProductsUrl = `/stores/${storeId}/products`;
  const returnTo = useMemo(
    () => sanitizeReturnTo(searchParams.get('returnTo'), plainProductsUrl),
    [searchParams, plainProductsUrl]
  );

  const statuses = [
    { value: 'draft', label: t('statusOptions.draft') },
    { value: 'active', label: t('statusOptions.active') },
    { value: 'archived', label: t('statusOptions.archived') },
  ];
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  /** Template of the store — used to show per-theme recommended upload sizes. */
  const [storeTemplate, setStoreTemplate] = useState<TemplateId | undefined>();
  const [images, setImages] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    nameAr: '',
    description: '',
    descriptionAr: '',
    /** Merchant-authored product card badge (EN / AR). Empty = no badge. */
    badgeLabel: '',
    badgeLabelAr: '',
    /** Extra shopper words (dialect/Franco/English); searched, never shown. */
    searchTerms: '',
    /** Regular (RRP) price as EGP string entered by the merchant. */
    price: '',
    costPrice: '',
    sku: '',
    inventory: '',
    /** Low-stock threshold — mirrors the edit form field. Absent here meant
     *  new products always fell back to the DB default (5) with no way to
     *  set a different value at creation time. */
    lowStockThreshold: '',
    category: '',
    status: 'draft',
  });

  // Discount state — separate from formData since they use non-string values.
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  /** Discount value string: percentage as "12.5" (displays as %) or EGP for fixed. */
  const [discountValue, setDiscountValue] = useState('');

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

    async function fetchStoreTemplate() {
      try {
        const { data } = await apiGet<{ store: { template?: TemplateId } }>(
          `/api/v1/admin/stores/${storeId}`
        );
        if (data?.store?.template) {
          setStoreTemplate(data.store.template);
        }
      } catch {
        // non-critical — falls back to base recommended size
      }
    }

    fetchCategories();
    fetchStoreTemplate();
  }, [storeId, isAuthenticated]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const regularPriceFils = roundToMinor(parseFloat(formData.price));
      const costPriceInFils = formData.costPrice
        ? roundToMinor(parseFloat(formData.costPrice))
        : null;

      // Derive price + compareAtPrice from the discount input.
      let finalPrice = regularPriceFils;
      let finalCompareAtPrice: number | null = null;
      let apiDiscountType: 'percentage' | 'fixed' | null = null;
      let apiDiscountValue: number | null = null;

      if (discountType !== 'none' && discountValue !== '') {
        if (discountType === 'percentage') {
          // UI shows decimal percent (e.g. 12.5) → store as basis points (1250).
          const pct = parseFloat(discountValue);
          if (Number.isFinite(pct) && pct > 0) {
            const basisPoints = Math.round(pct * 100);
            const result = applyDiscount(regularPriceFils, 'percentage', basisPoints);
            finalPrice = result.price;
            finalCompareAtPrice = result.compareAtPrice;
            apiDiscountType = 'percentage';
            apiDiscountValue = basisPoints;
          }
        } else {
          // Fixed EGP → piastres.
          const fixedFils = roundToMinor(parseFloat(discountValue));
          if (Number.isFinite(fixedFils) && fixedFils > 0) {
            const result = applyDiscount(regularPriceFils, 'fixed', fixedFils);
            finalPrice = result.price;
            finalCompareAtPrice = result.compareAtPrice;
            apiDiscountType = 'fixed';
            apiDiscountValue = fixedFils;
          }
        }
      }

      const body: Record<string, unknown> = {
        name: formData.name,
        // CREATE path — nothing to clear, so an empty field omits the key
        // entirely (`undefined`). The EDIT form sends `null` instead; see
        // lib/product-payload.ts.
        ...productTextFields(formData, 'create'),
        price: finalPrice,
        compareAtPrice: finalCompareAtPrice,
        costPrice: costPriceInFils,
        discountType: apiDiscountType,
        discountValue: apiDiscountValue,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        ...(formData.lowStockThreshold !== ''
          ? { lowStockThreshold: parseInt(formData.lowStockThreshold, 10) }
          : {}),
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
        // invalidate App Router cache so the destination list re-fetches the saved row
        router.refresh();
        router.push(returnTo);
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
          <div className="mb-6 rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink">
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
                <SearchTermsField
                  namespace="products.new.fields"
                  value={formData.searchTerms}
                  onChange={v => updateField('searchTerms', v)}
                />
                {/* Card badge — the merchant's own promotional chip, shown on
                    every product-card render path and on the PDP. Bilingual
                    like every other free-text field; empty = no badge. */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t('fields.badgeLabel')}
                    value={formData.badgeLabel}
                    onChange={e => updateField('badgeLabel', e.target.value)}
                    placeholder={t('fields.badgeLabelPlaceholder')}
                    maxLength={PRODUCT_BADGE_LABEL_MAX_LENGTH}
                  />
                  <Input
                    label={t('fields.badgeLabelAr')}
                    value={formData.badgeLabelAr}
                    onChange={e => updateField('badgeLabelAr', e.target.value)}
                    placeholder={t('fields.badgeLabelArPlaceholder')}
                    maxLength={PRODUCT_BADGE_LABEL_MAX_LENGTH}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('fields.badgeLabelHint')}</p>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <div className="mb-4 flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-foreground">{t('sections.media')}</h2>
                <p className="text-xs text-muted-foreground">{t('fields.mediaSizeHint')}</p>
              </div>
              <MultiImageUpload
                values={images}
                onChange={setImages}
                folder="products"
                storeId={storeId}
                label={t('fields.mediaHint')}
                max={10}
                recommendedSizeHint={recommendedSizeTextForTemplate(
                  'productPrimary',
                  storeTemplate
                )}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                {t('sections.pricing')}
              </h2>
              {/* Row 1: Price (regular) + Cost */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('fields.price')}
                  type="number"
                  step="0.01"
                  min={0}
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder={t('fields.pricePlaceholder')}
                  required
                />
                <Input
                  label={t('fields.costPrice')}
                  type="number"
                  step="0.01"
                  min={0}
                  value={formData.costPrice}
                  onChange={e => updateField('costPrice', e.target.value)}
                  placeholder={t('fields.pricePlaceholder')}
                />
              </div>
              {/* Row 2: Discount dropdown + value input */}
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Select
                  label={t('fields.discountLabel')}
                  value={discountType}
                  onChange={e => {
                    setDiscountType(e.target.value as DiscountType);
                    setDiscountValue('');
                  }}
                  options={[
                    { value: 'none', label: t('fields.discountNone') },
                    { value: 'percentage', label: t('fields.discountPercentage') },
                    { value: 'fixed', label: t('fields.discountFixed') },
                  ]}
                />
                {discountType !== 'none' && (
                  <Input
                    label={
                      discountType === 'percentage'
                        ? t('fields.discountPercentage')
                        : t('fields.discountFixed')
                    }
                    type="number"
                    step={discountType === 'percentage' ? '0.01' : '0.01'}
                    min={0}
                    max={discountType === 'percentage' ? 100 : undefined}
                    value={discountValue}
                    onChange={e => setDiscountValue(e.target.value)}
                    placeholder={
                      discountType === 'percentage'
                        ? t('fields.discountPercentagePlaceholder')
                        : t('fields.discountValuePlaceholder')
                    }
                  />
                )}
              </div>
              {/* Row 3: Preview cell */}
              {(() => {
                if (discountType === 'none' || !discountValue || !formData.price) return null;
                const regularFils = roundToMinor(parseFloat(formData.price));
                if (!Number.isFinite(regularFils) || regularFils <= 0) return null;

                let discountedFils = regularFils;
                let pctOff = 0;

                if (discountType === 'percentage') {
                  const pct = parseFloat(discountValue);
                  if (!Number.isFinite(pct) || pct <= 0) return null;
                  const basisPoints = Math.round(pct * 100);
                  const amount = computeDiscountAmount(regularFils, 'percentage', basisPoints);
                  discountedFils = regularFils - amount;
                  pctOff = pct;
                } else {
                  const fixedFils = roundToMinor(parseFloat(discountValue));
                  if (!Number.isFinite(fixedFils) || fixedFils <= 0) return null;
                  const amount = computeDiscountAmount(regularFils, 'fixed', fixedFils);
                  discountedFils = regularFils - amount;
                  pctOff = (amount / regularFils) * 100;
                }

                if (discountedFils <= 0 || discountedFils >= regularFils) return null;

                return (
                  <div className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
                    <p className="text-xs text-muted-foreground mb-1">
                      {t('fields.discountPreviewLabel')}
                    </p>
                    <p className="text-base font-semibold text-foreground">
                      {formatPrice(discountedFils)}{' '}
                      <span className="ml-2 text-sm font-normal line-through text-muted-foreground">
                        {formatPrice(regularFils)}
                      </span>{' '}
                      <span className="ml-1 text-sm font-medium text-success-ink">
                        {t('fields.discountOff', { pct: pctOff.toFixed(1).replace(/\.0$/, '') })}
                      </span>
                    </p>
                  </div>
                );
              })()}
              <p className="mt-3 text-xs text-muted-foreground">{t('fields.pricingHint')}</p>
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
                <Input
                  label={t('fields.lowStockThreshold')}
                  type="number"
                  min={0}
                  value={formData.lowStockThreshold}
                  onChange={e => updateField('lowStockThreshold', e.target.value)}
                  placeholder={t('fields.lowStockThresholdPlaceholder')}
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
                  onClick={() => router.push(returnTo)}
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
