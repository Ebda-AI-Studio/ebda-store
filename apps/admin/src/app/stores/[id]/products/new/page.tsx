'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { SearchTermsField } from '@/components/SearchTermsField';
import { Input, Textarea, Select, useToast, MinusGlyph, PlusGlyph } from '@ebda/ui';
import { FormFooter } from '@/components/FormFooter';
import { AITranslateMissingButton } from '@/components/AITranslateMissingButton';
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
import { useLocale } from 'next-intl';

type DiscountType = 'none' | 'percentage' | 'fixed';

interface Category {
  id: string;
  name: string;
  nameAr?: string | null;
}

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const storeId = params?.id as string;
  const { isAuthenticated } = useAuth();
  const t = useT('products.new');
  const toast = useToast();
  const uiLocale = useLocale();

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
  /** Store's default language decides which name field comes first (UX:PN-2). Falls back to the admin language. */
  const [storeLang, setStoreLang] = useState<'ar' | 'en' | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const arFirst = (storeLang ?? (uiLocale === 'ar' ? 'ar' : 'en')) === 'ar';

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
        const { data } = await apiGet<{
          store: { template?: TemplateId; settings?: { defaultLanguage?: string } | null };
        }>(`/api/v1/admin/stores/${storeId}`);
        if (data?.store?.template) {
          setStoreTemplate(data.store.template);
        }
        const lang = data?.store?.settings?.defaultLanguage;
        if (lang === 'ar' || lang === 'en') setStoreLang(lang);
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
    if (isLoading) return;
    setError(null);
    // UX:PN-3 - a zero or negative price is rejected here, with the field named, before any request.
    const priceNum = parseFloat(formData.price);
    if (!Number.isFinite(priceNum) || priceNum < 0.01) {
      setPriceError(t('errors.priceMin'));
      return;
    }
    setPriceError(null);
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
        // Each name in its own field (Ruling NAME-PAIR-1): an Arabic-only product sends only nameAr and the API keeps the
        // English name for the AI to fill. Sending the Arabic text as `name` put Arabic on the English storefront.
        ...(formData.name.trim() ? { name: formData.name.trim() } : {}),
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

      const { data, error: apiError } = await apiPost<{ product?: { id: string } }>(
        `/api/v1/stores/${storeId}/products`,
        body
      );

      if (apiError) {
        setError(apiError.message);
        setIsLoading(false);
        return;
      }

      if (data) {
        // UX:PN-1 - no router.refresh() and no setIsLoading(false) on success: the button stays disabled until
        // the route changes, so a slow network cannot produce a second click and a second product.
        toast.success(t('toast.created'));
        const newId = data.product?.id;
        router.push(
          newId
            ? `/stores/${storeId}/products/${newId}/edit?created=1&returnTo=${encodeURIComponent(returnTo)}`
            : returnTo
        );
        return;
      }
      setIsLoading(false);
    } catch {
      setError(t('errors.createFailed'));
      setIsLoading(false);
    }
  };

  const categoryOptions = [
    { value: '', label: t('fields.noCategory') },
    ...categories.map(c => ({
      value: c.id,
      label: uiLocale === 'ar' && c.nameAr ? c.nameAr : c.name,
    })),
  ];

  const nameField = (lang: 'ar' | 'en', required: boolean) =>
    lang === 'ar' ? (
      <Input
        label={required ? t('fields.nameAr') : t('fields.nameArOptional')}
        value={formData.nameAr}
        onChange={e => updateField('nameAr', e.target.value)}
        placeholder={t('fields.nameArPlaceholder')}
        lang="ar"
        dir="rtl"
        required={required}
      />
    ) : (
      <Input
        label={required ? t('fields.name') : t('fields.nameOptional')}
        value={formData.name}
        onChange={e => updateField('name', e.target.value)}
        placeholder={t('fields.namePlaceholder')}
        required={required}
      />
    );

  const secondLang = arFirst ? 'en' : 'ar';

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <form onSubmit={handleSubmit} noValidate={false}>
        {error && (
          <div
            role="alert"
            className="mb-6 rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-6">
          {/* Essentials: the only things a product needs to exist. Everything else is behind "more details". */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-foreground">
              {t('sections.essentials')}
            </h2>
            <div className="space-y-4">
              {nameField(arFirst ? 'ar' : 'en', true)}
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('fields.price')}
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={formData.price}
                  onChange={e => {
                    updateField('price', e.target.value);
                    if (priceError) setPriceError(null);
                  }}
                  placeholder={t('fields.pricePlaceholder')}
                  error={priceError ?? undefined}
                  required
                />
                <Input
                  label={t('fields.quantity')}
                  type="number"
                  min={0}
                  value={formData.inventory}
                  onChange={e => updateField('inventory', e.target.value)}
                  placeholder={t('fields.quantityPlaceholder')}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  label={t('fields.category')}
                  value={formData.category}
                  onChange={e => updateField('category', e.target.value)}
                  options={categoryOptions}
                />
                <Select
                  label={t('fields.productStatus')}
                  value={formData.status}
                  onChange={e => updateField('status', e.target.value)}
                  options={statuses}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
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
              recommendedSizeHint={recommendedSizeTextForTemplate('productPrimary', storeTemplate)}
            />
          </div>

          <div className="rounded-xl border bg-card shadow-sm">
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => setShowDetails(v => !v)}
              data-ui="row"
              className="flex min-h-11 w-full items-center justify-between gap-3 p-6 text-start"
            >
              <span>
                <span className="block text-lg font-semibold text-foreground">
                  {t('sections.moreDetails')}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t('sections.moreDetailsHint')}
                </span>
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                {showDetails ? <MinusGlyph /> : <PlusGlyph />}
              </span>
            </button>
            {showDetails && (
              <div className="space-y-6 border-t border-border p-6">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t(secondLang === 'en' ? 'sections.englishCopy' : 'sections.arabicCopy')}
                    </h3>
                    <AITranslateMissingButton
                      storeId={storeId}
                      pairs={[
                        {
                          key: 'name',
                          en: formData.name,
                          ar: formData.nameAr,
                          kind: 'product-name',
                          onEnFilled: v => updateField('name', v),
                          onArFilled: v => updateField('nameAr', v),
                        },
                        {
                          key: 'description',
                          en: formData.description,
                          ar: formData.descriptionAr,
                          kind: 'product-description',
                          onEnFilled: v => updateField('description', v),
                          onArFilled: v => updateField('descriptionAr', v),
                        },
                      ]}
                    />
                  </div>
                  {nameField(secondLang, false)}
                </div>

                <div className="space-y-4">
                  {(arFirst ? (['ar', 'en'] as const) : (['en', 'ar'] as const)).map(lang =>
                    lang === 'ar' ? (
                      <Textarea
                        key="descAr"
                        label={t('fields.descriptionAr')}
                        value={formData.descriptionAr}
                        onChange={e => updateField('descriptionAr', e.target.value)}
                        placeholder={t('fields.descriptionArPlaceholder')}
                        rows={4}
                        lang="ar"
                        dir="rtl"
                      />
                    ) : (
                      <Textarea
                        key="descEn"
                        label={t('fields.description')}
                        value={formData.description}
                        onChange={e => updateField('description', e.target.value)}
                        placeholder={t('fields.descriptionPlaceholder')}
                        rows={4}
                      />
                    )
                  )}
                  <SearchTermsField
                    namespace="products.new.fields"
                    value={formData.searchTerms}
                    onChange={v => updateField('searchTerms', v)}
                  />
                </div>

                <div>
                  <h3 className="mb-3 text-sm font-semibold text-foreground">
                    {t('sections.pricing')}
                  </h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label={t('fields.costPrice')}
                      type="number"
                      step="0.01"
                      min={0}
                      value={formData.costPrice}
                      onChange={e => updateField('costPrice', e.target.value)}
                      placeholder={t('fields.pricePlaceholder')}
                    />
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
                        step="0.01"
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
                          <span className="ms-2 text-sm font-normal line-through text-muted-foreground">
                            {formatPrice(regularFils)}
                          </span>{' '}
                          <span className="ms-1 text-sm font-medium text-success-ink">
                            {t('fields.discountOff', {
                              pct: pctOff.toFixed(1).replace(/\.0$/, ''),
                            })}
                          </span>
                        </p>
                      </div>
                    );
                  })()}
                  <p className="mt-3 text-xs text-muted-foreground">{t('fields.pricingHint')}</p>
                </div>

                <div>
                  <h3 className="mb-3 text-sm font-semibold text-foreground">
                    {t('sections.inventory')}
                  </h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label={t('fields.sku')}
                      value={formData.sku}
                      onChange={e => updateField('sku', e.target.value)}
                      placeholder={t('fields.skuPlaceholder')}
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

                {/* Card badge: the merchant's own promotional chip. Empty = no badge. */}
                <div>
                  <h3 className="mb-3 text-sm font-semibold text-foreground">
                    {t('sections.badge')}
                  </h3>
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
                  <p className="mt-2 text-xs text-muted-foreground">{t('fields.badgeLabelHint')}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <FormFooter primaryLabel={t('actions.create')} cancelHref={returnTo} saving={isLoading} />
      </form>
    </AdminLayout>
  );
}
