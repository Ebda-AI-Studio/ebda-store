'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Button, Input, Textarea, Select } from '@force/ui';
import {
  recommendedSizeTextForTemplate,
  type TemplateId,
  applyDiscount,
  computeDiscountAmount,
  deriveDiscountInput,
  formatPrice,
} from '@force/shared';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';

type DiscountTypeUI = 'none' | 'percentage' | 'fixed';
import Link from 'next/link';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../../../components/ImageUpload';
import { AITranslateMissingButton } from '../../../../../../components/AITranslateMissingButton';
import { useAuth } from '../../../../../../lib/auth';
import { apiGet, apiPost, apiPut } from '../../../../../../lib/api';
import { productTextFields } from '../../../../../../lib/product-payload';
import { sanitizeReturnTo } from '../../../../../../lib/return-to';
import { EditSidebar } from './_components/EditSidebar';
import { ProductFaqSection, type ProductFaqSectionHandle } from './_components/ProductFaqSection';
import { AiFieldBadge } from './_components/AiFieldBadge';
import { BalanceDescriptionButton } from './_components/BalanceDescriptionButton';

interface Product {
  id: string;
  storeId: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  /** Short 1-2 sentence blurb — written by the bulk-ai-excerpt sweep or manually. */
  excerpt?: string;
  excerptAr?: string;
  price: number;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | null;
  sku?: string;
  inventory: number;
  lowStockThreshold?: number;
  status: string;
  isFeatured: boolean;
  isNew: boolean;
  isBestSeller: boolean;
  /** Merchant-authored product card badge (EN / AR). null = no badge. */
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
  categories: { categoryId: string; category: { id: string; name: string } }[];
  images: { id: string; url: string; alt?: string; position: number }[];
  store: { id: string; name: string; slug: string };
  /** AI-first autofill provenance map over the AI-writable fields. */
  aiFieldSources?: Record<string, 'ai' | 'human'>;
}

interface Category {
  id: string;
  name: string;
  nameAr?: string;
}

export default function EditProductPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;
  const productId = params?.productId as string;
  const t = useT('products.edit');
  const tSections = useT('products.edit.sections');
  const tFields = useT('products.edit.fields');
  const tStatusOptions = useT('products.edit.statusOptions');
  const tSeo = useT('products.edit.seoSection');
  const locale = useLocale();

  // Plain products-list URL — the fallback whenever `returnTo` is absent or
  // doesn't point back into this store's product list (open-redirect guard).
  const plainProductsUrl = `/stores/${storeId}/products`;
  const returnTo = useMemo(
    () => sanitizeReturnTo(searchParams.get('returnTo'), plainProductsUrl),
    [searchParams, plainProductsUrl]
  );

  const [product, setProduct] = useState<Product | null>(null);
  // Local mirror of the product's AI-provenance map. Kept in state so the
  // "✨ Switch to AI" hand-back flips a field's chip to "✨ AI" live without
  // a reload.
  const [aiSources, setAiSources] = useState<Record<string, 'ai' | 'human'>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  /** Template of the store — used to show per-theme recommended upload sizes. */
  const [storeTemplate, setStoreTemplate] = useState<TemplateId | undefined>();
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
    excerpt: '',
    excerptAr: '',
    /** Regular (RRP) price as KWD string. Derived from product on load via deriveDiscountInput. */
    price: '',
    // Cost-of-goods. Used for profit reporting (price - costPrice = margin)
    // and snapshotted onto OrderItem at sale time. Stored in fils on the
    // server, displayed/edited as KWD in the form.
    costPrice: '',
    sku: '',
    inventory: '',
    // Per-product low-stock threshold — drives the LOW STOCK badge + alerts.
    lowStockThreshold: '',
    status: 'draft',
    isFeatured: false,
    isNew: false,
    isBestSeller: false,
    badgeLabel: '',
    badgeLabelAr: '',
    category: '',
    metaTitle: '',
    metaTitleAr: '',
    metaDescription: '',
    metaDescriptionAr: '',
    metaDescriptionAeo: '',
    metaDescriptionAeoAr: '',
  });

  // Discount state — separate from formData since type is a union, not string.
  const [discountType, setDiscountType] = useState<DiscountTypeUI>('none');
  /** Discount value string: "12.5" for percentage (%), or KWD decimal for fixed. */
  const [discountValue, setDiscountValue] = useState('');

  const [seoGenerating, setSeoGenerating] = useState(false);
  const [seoMessage, setSeoMessage] = useState<string | null>(null);
  // "Generate with AI" also drafts FAQs — reuses ProductFaqSection's own
  // draft-endpoint call + review-before-save UX via an imperative handle
  // instead of duplicating the FAQ save/draft logic here.
  const faqSectionRef = useRef<ProductFaqSectionHandle>(null);

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

        const [productResult, categoriesResult, storeResult] = await Promise.all([
          apiGet<{ product?: Product } & Product>(
            `/api/v1/stores/${storeId}/products/${productId}`
          ),
          apiGet<{ categories: Category[] }>(`/api/v1/stores/${storeId}/categories`),
          // Fetch store template for per-theme upload-size hint (non-critical).
          apiGet<{ store: { template?: TemplateId } }>(`/api/v1/admin/stores/${storeId}`),
        ]);
        if (storeResult.data?.store?.template) {
          setStoreTemplate(storeResult.data.store.template);
        }

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
        setAiSources(((p as Product).aiFieldSources as Record<string, 'ai' | 'human'>) ?? {});

        if (p.images?.length) {
          setImages(
            [...p.images]
              .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
              .map((img: { url: string }) => img.url)
          );
        }

        // Derive the regular price + discount fields from the stored product.
        const derived = deriveDiscountInput({
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          discountType: p.discountType ?? null,
          discountValue: p.discountValue ?? null,
        });

        setFormData({
          name: p.name || '',
          nameAr: p.nameAr || '',
          description: p.description || '',
          descriptionAr: p.descriptionAr || '',
          excerpt: (p as Product & { excerpt?: string }).excerpt || '',
          excerptAr: (p as Product & { excerptAr?: string }).excerptAr || '',
          // Show the regular (RRP) price, not the discounted price.
          price: derived.regularPrice ? (derived.regularPrice / 1000).toFixed(3) : '',
          costPrice: p.costPrice ? (p.costPrice / 1000).toFixed(3) : '',
          sku: p.sku || '',
          inventory: String(p.inventory ?? 0),
          lowStockThreshold:
            p.lowStockThreshold === undefined || p.lowStockThreshold === null
              ? ''
              : String(p.lowStockThreshold),
          status: p.status || 'draft',
          isFeatured: p.isFeatured || false,
          isNew: p.isNew || false,
          isBestSeller: p.isBestSeller || false,
          badgeLabel: p.badgeLabel || '',
          badgeLabelAr: p.badgeLabelAr || '',
          category: p.categories?.[0]?.categoryId || p.categories?.[0]?.category?.id || '',
          metaTitle: (p as Product & { metaTitle?: string }).metaTitle || '',
          metaTitleAr: (p as Product & { metaTitleAr?: string }).metaTitleAr || '',
          metaDescription: (p as Product & { metaDescription?: string }).metaDescription || '',
          metaDescriptionAr:
            (p as Product & { metaDescriptionAr?: string }).metaDescriptionAr || '',
          metaDescriptionAeo:
            (p as Product & { metaDescriptionAeo?: string }).metaDescriptionAeo || '',
          metaDescriptionAeoAr:
            (p as Product & { metaDescriptionAeoAr?: string }).metaDescriptionAeoAr || '',
        });

        // Pre-populate discount controls from derived input.
        setDiscountType(derived.type);
        if (derived.type === 'percentage') {
          // stored as basis points → display as decimal percent (12.5).
          setDiscountValue(String(derived.value / 100));
        } else if (derived.type === 'fixed') {
          // stored as fils → display as KWD.
          setDiscountValue((derived.value / 1000).toFixed(3));
        } else {
          setDiscountValue('');
        }
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

  // Hand-back-to-AI callback: the API has already regenerated + saved the
  // field, so write the fresh value into the form and flip its provenance
  // chip to "✨ AI" locally.
  const handleAiReset = (field: string, value: string | null) => {
    updateField(field, value ?? '');
    setAiSources(prev => ({ ...prev, [field]: 'ai' }));
  };

  // Four-field balance/revert callback: the balance or revert endpoint returns
  // fresh values for ALL four name+description fields. Update all four form
  // inputs and flip their provenance chips to "ai" so the ✨ AI chips render.
  const handleBalanced = (
    nameEn: string,
    nameAr: string,
    descriptionEn: string,
    descriptionAr: string
  ) => {
    setFormData(prev => ({
      ...prev,
      name: nameEn,
      nameAr,
      description: descriptionEn,
      descriptionAr,
    }));
    setAiSources(prev => ({
      ...prev,
      name: 'ai',
      nameAr: 'ai',
      description: 'ai',
      descriptionAr: 'ai',
    }));
  };

  /**
   * "Generate with AI" — fills SEO meta, AEO meta, AND drafts FAQs in one
   * action (the merchant-reported gap: it used to only touch SEO). Calls
   * all three AI endpoints; partial-failure tolerant — if one call fails
   * the other two still apply, and the failure is reported in seoMessage
   * rather than aborting the whole action. FAQ drafting reuses
   * ProductFaqSection's own draft-endpoint call (via imperative handle) so
   * the review-before-save UX (accept/discard per row) isn't duplicated
   * here — FAQs are never auto-persisted, matching fill-empty/overwrite
   * mode only applying to the meta text fields.
   */
  async function generateAiContent(mode: 'fill-empty' | 'overwrite') {
    if (!product) return;
    setSeoMessage(null);
    setSeoGenerating(true);
    const failures: string[] = [];
    try {
      // Promise.allSettled (NOT all) so a REJECTED call can't abort the others —
      // apiPost resolves {data,error} without throwing, but the FAQ handle's
      // generateWithAi() can throw, and Promise.all would have rejected on it and
      // discarded already-succeeded SEO/AEO writes. This is what makes the action
      // genuinely partial-failure tolerant.
      const settled = await Promise.allSettled([
        apiPost<{
          suggestion: {
            title: string;
            titleAr: string;
            description: string;
            descriptionAr: string;
            keywords: string[];
          };
        }>(`/api/v1/stores/${storeId}/ai/seo`, { kind: 'product', id: product.id }),
        apiPost<{ aeo: { en: string; ar: string } }>(
          `/api/v1/stores/${storeId}/ai/product-meta-aeo`,
          { productId: product.id }
        ),
        faqSectionRef.current?.generateWithAi() ?? Promise.resolve(true),
      ]);
      const seoResult =
        settled[0].status === 'fulfilled'
          ? settled[0].value
          : { data: undefined, error: { message: 'request failed' } };
      const aeoResult =
        settled[1].status === 'fulfilled'
          ? settled[1].value
          : { data: undefined, error: { message: 'request failed' } };
      const faqOk = settled[2].status === 'fulfilled' ? settled[2].value : false;

      if (seoResult.error || !seoResult.data) {
        failures.push(
          tSeo('failureSeo', { message: seoResult.error?.message || tSeo('genericFailed') })
        );
      } else {
        const s = seoResult.data.suggestion;
        setFormData(prev => ({
          ...prev,
          metaTitle: mode === 'overwrite' || !prev.metaTitle ? s.title : prev.metaTitle,
          metaTitleAr: mode === 'overwrite' || !prev.metaTitleAr ? s.titleAr : prev.metaTitleAr,
          metaDescription:
            mode === 'overwrite' || !prev.metaDescription ? s.description : prev.metaDescription,
          metaDescriptionAr:
            mode === 'overwrite' || !prev.metaDescriptionAr
              ? s.descriptionAr
              : prev.metaDescriptionAr,
        }));
      }

      if (aeoResult.error || !aeoResult.data) {
        failures.push(
          tSeo('failureAeo', { message: aeoResult.error?.message || tSeo('genericFailed') })
        );
      } else {
        const aeo = aeoResult.data.aeo;
        setFormData(prev => ({
          ...prev,
          metaDescriptionAeo:
            mode === 'overwrite' || !prev.metaDescriptionAeo ? aeo.en : prev.metaDescriptionAeo,
          metaDescriptionAeoAr:
            mode === 'overwrite' || !prev.metaDescriptionAeoAr ? aeo.ar : prev.metaDescriptionAeoAr,
        }));
      }

      if (!faqOk) {
        failures.push(tSeo('failureFaqs'));
      }

      setSeoMessage(
        failures.length === 0
          ? tSeo('generateSuccessMessage')
          : tSeo('generatePartialFailureMessage', {
              failures: failures.join(locale === 'ar' ? '، ' : ', '),
            })
      );
    } catch {
      setSeoMessage(tSeo('networkError'));
    } finally {
      setSeoGenerating(false);
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;

    setError(null);
    setSaving(true);

    try {
      const regularPriceFils = Math.round(parseFloat(formData.price) * 1000);
      const costPriceInFils = formData.costPrice
        ? Math.round(parseFloat(formData.costPrice) * 1000)
        : null;

      // Derive price + compareAtPrice from the discount input.
      let finalPrice = regularPriceFils;
      // Use `null` to explicitly clear an existing compare-at-price when
      // no discount is set (Prisma needs null not undefined to clear the column).
      let finalCompareAtPrice: number | null = null;
      let apiDiscountType: 'percentage' | 'fixed' | null = null;
      let apiDiscountValue: number | null = null;

      if (discountType !== 'none' && discountValue !== '') {
        if (discountType === 'percentage') {
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
          const fixedFils = Math.round(parseFloat(discountValue) * 1000);
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
        // Clearable free text (nameAr / description / descriptionAr / sku).
        // null clears, undefined leaves alone — same convention as metaTitle
        // below. These MUST send null: `undefined` omits the key, so an
        // emptied field saved with no effect and could never be cleared.
        ...productTextFields(formData, 'update'),
        excerpt: formData.excerpt || null,
        excerptAr: formData.excerptAr || null,
        price: finalPrice,
        // null clears an existing compare-at price when no discount is active.
        compareAtPrice: finalCompareAtPrice,
        costPrice: costPriceInFils,
        // null clears previously stored discount columns.
        discountType: apiDiscountType,
        discountValue: apiDiscountValue,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        // Only send when filled so an empty field doesn't clobber the existing
        // threshold with 0. The API leaves it untouched when omitted.
        ...(formData.lowStockThreshold !== ''
          ? { lowStockThreshold: parseInt(formData.lowStockThreshold, 10) }
          : {}),
        status: formData.status,
        isFeatured: formData.isFeatured,
        isNew: formData.isNew,
        isBestSeller: formData.isBestSeller,
        // null clears, undefined leaves alone — same convention as compareAtPrice.
        metaTitle: formData.metaTitle || null,
        metaTitleAr: formData.metaTitleAr || null,
        metaDescription: formData.metaDescription || null,
        metaDescriptionAr: formData.metaDescriptionAr || null,
        metaDescriptionAeo: formData.metaDescriptionAeo || null,
        metaDescriptionAeoAr: formData.metaDescriptionAeoAr || null,
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

      // Return to the products list after a successful edit (matches the
      // create flow), so the merchant lands back where they can keep working
      // through their catalog instead of on the single-product detail page.
      // `returnTo` (when present and same-store) restores the exact
      // filtered+searched+paginated list view the merchant came from.
      // invalidate App Router cache so the destination list re-fetches the saved row
      router.refresh();
      router.push(returnTo);
    } catch {
      setError(t('updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = [
    { value: '', label: tFields('noCategory') },
    ...categories.map(c => ({
      value: c.id,
      label: locale === 'ar' && c.nameAr ? c.nameAr : c.name,
    })),
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
          <Button className="mt-6" onClick={() => router.push(returnTo)}>
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
      actions={
        product ? (
          // flex-wrap so both buttons stay visible at narrow viewport
          // widths instead of pushing one off-screen.
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/stores/${storeId}/products/${product.id}/variants`}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            >
              {t('manageVariants')}
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </Link>
            <Link
              href={`/stores/${storeId}/products/${product.id}/recommendations`}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            >
              {t('recommendations')}
            </Link>
          </div>
        ) : undefined
      }
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
              <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-foreground">
                  {tSections('basicInformation')}
                </h2>
                <div className="flex items-center gap-2 flex-wrap">
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
                        en: formData.description ?? '',
                        ar: formData.descriptionAr ?? '',
                        kind: 'product-description',
                        onEnFilled: v => updateField('description', v),
                        onArFilled: v => updateField('descriptionAr', v),
                      },
                    ]}
                  />
                  <BalanceDescriptionButton
                    storeId={storeId}
                    productId={product?.id}
                    onBalanced={handleBalanced}
                  />
                </div>
              </div>
              <div className="space-y-4">
                <Input
                  label={tFields('name')}
                  value={formData.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={tFields('namePlaceholder')}
                  required
                />
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="nameAr"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
                  <Input
                    label={tFields('nameAr')}
                    value={formData.nameAr}
                    onChange={e => updateField('nameAr', e.target.value)}
                    placeholder={tFields('nameArPlaceholder')}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
                <Textarea
                  label={tFields('description')}
                  value={formData.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={tFields('descriptionPlaceholder')}
                  rows={4}
                />
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="descriptionAr"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
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
                <div>
                  <div className="mb-1 flex justify-end">
                    {/* No storeId/productId here on purpose: `excerpt` is written
                        by the standalone bulk-ai-excerpt sweep, not the
                        AI_AUTOFILL_FIELDS autopilot list, so the reset-field
                        endpoint doesn't support regenerating it. Omitting the
                        ids keeps the badge display-only (the "✨ AI" chip
                        still renders; the "Switch to AI" hand-back button,
                        which would 400, never does). */}
                    <AiFieldBadge field="excerpt" sources={aiSources} />
                  </div>
                  <Textarea
                    label={tFields('excerpt')}
                    value={formData.excerpt}
                    onChange={e => updateField('excerpt', e.target.value)}
                    placeholder={tFields('excerptPlaceholder')}
                    rows={2}
                  />
                </div>
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge field="excerptAr" sources={aiSources} />
                  </div>
                  <Textarea
                    label={tFields('excerptAr')}
                    value={formData.excerptAr}
                    onChange={e => updateField('excerptAr', e.target.value)}
                    placeholder={tFields('excerptArPlaceholder')}
                    rows={2}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
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
                storeId={storeId}
                label={tFields('mediaHint')}
                max={10}
                recommendedSizeHint={recommendedSizeTextForTemplate(
                  'productPrimary',
                  storeTemplate
                )}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('pricing')}</h2>
              {/* Row 1: Price (regular) + Cost */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={tFields('price')}
                  type="number"
                  step="0.001"
                  min={0}
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder={tFields('pricePlaceholder')}
                  required
                />
                <Input
                  label={tFields('costPrice')}
                  type="number"
                  step="0.001"
                  min={0}
                  value={formData.costPrice}
                  onChange={e => updateField('costPrice', e.target.value)}
                  placeholder={tFields('pricePlaceholder')}
                />
              </div>
              {/* Row 2: Discount dropdown + value input */}
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Select
                  label={tFields('discountLabel')}
                  value={discountType}
                  onChange={e => {
                    setDiscountType(e.target.value as DiscountTypeUI);
                    setDiscountValue('');
                  }}
                  options={[
                    { value: 'none', label: tFields('discountNone') },
                    { value: 'percentage', label: tFields('discountPercentage') },
                    { value: 'fixed', label: tFields('discountFixed') },
                  ]}
                />
                {discountType !== 'none' && (
                  <Input
                    label={
                      discountType === 'percentage'
                        ? tFields('discountPercentage')
                        : tFields('discountFixed')
                    }
                    type="number"
                    step={discountType === 'percentage' ? '0.01' : '0.001'}
                    min={0}
                    max={discountType === 'percentage' ? 100 : undefined}
                    value={discountValue}
                    onChange={e => setDiscountValue(e.target.value)}
                    placeholder={
                      discountType === 'percentage'
                        ? tFields('discountPercentagePlaceholder')
                        : tFields('discountValuePlaceholder')
                    }
                  />
                )}
              </div>
              {/* Row 3: Preview cell */}
              {(() => {
                if (discountType === 'none' || !discountValue || !formData.price) return null;
                const regularFils = Math.round(parseFloat(formData.price) * 1000);
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
                  const fixedFils = Math.round(parseFloat(discountValue) * 1000);
                  if (!Number.isFinite(fixedFils) || fixedFils <= 0) return null;
                  const amount = computeDiscountAmount(regularFils, 'fixed', fixedFils);
                  discountedFils = regularFils - amount;
                  pctOff = (amount / regularFils) * 100;
                }

                if (discountedFils <= 0 || discountedFils >= regularFils) return null;

                return (
                  <div className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
                    <p className="text-xs text-muted-foreground mb-1">
                      {tFields('discountPreviewLabel')}
                    </p>
                    <p className="text-base font-semibold text-foreground">
                      {formatPrice(discountedFils)}{' '}
                      <span className="ml-2 text-sm font-normal line-through text-muted-foreground">
                        {formatPrice(regularFils)}
                      </span>{' '}
                      <span className="ml-1 text-sm font-medium text-success">
                        {tFields('discountOff').replace(
                          '{pct}',
                          pctOff.toFixed(1).replace(/\.0$/, '')
                        )}
                      </span>
                    </p>
                  </div>
                );
              })()}
              {/* Live profit hint — only renders when both price and cost are filled */}
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
              <div className="grid gap-4 sm:grid-cols-3">
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
                <Input
                  label={tFields('lowStockThreshold')}
                  type="number"
                  min={0}
                  value={formData.lowStockThreshold}
                  onChange={e => updateField('lowStockThreshold', e.target.value)}
                  placeholder={tFields('lowStockThresholdPlaceholder')}
                />
              </div>
            </div>

            {/* SEO meta — what shows up on Google + social shares.
                "Generate with AI" now fills SEO + AEO meta AND drafts FAQs
                in one action (calls /ai/seo, /ai/product-meta-aeo, and the
                FAQ section's own draft endpoint — the same endpoints the
                bulk sweeps use, so per-product regeneration stays
                consistent with the catalogue-wide flow). */}
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{tSections('seo')}</h2>
                  <p className="text-xs text-muted-foreground">{tSeo('hint')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => generateAiContent('fill-empty')}
                    disabled={seoGenerating}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#fc6b02]/40 bg-[#fc6b02]/5 px-3 py-1.5 text-xs font-semibold text-[#fc6b02] transition-colors hover:bg-[#fc6b02]/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span aria-hidden>✨</span>
                    {seoGenerating ? tSeo('generating') : tSeo('aiFillEmpty')}
                  </button>
                  <button
                    type="button"
                    onClick={() => generateAiContent('overwrite')}
                    disabled={seoGenerating}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#fc6b02] px-3 py-1.5 text-xs font-semibold text-[#fc6b02] transition-colors hover:bg-[#fc6b02]/5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {tSeo('aiRegenerateAll')}
                  </button>
                </div>
              </div>
              {seoMessage && <p className="mb-3 text-xs text-muted-foreground">{seoMessage}</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="metaTitle"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
                  <Input
                    label={tSeo('metaTitleLabel', { count: formData.metaTitle.length })}
                    value={formData.metaTitle}
                    onChange={e => updateField('metaTitle', e.target.value)}
                    maxLength={70}
                  />
                </div>
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="metaTitleAr"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
                  <Input
                    label={tSeo('metaTitleArLabel', { count: formData.metaTitleAr.length })}
                    value={formData.metaTitleAr}
                    onChange={e => updateField('metaTitleAr', e.target.value)}
                    maxLength={70}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="metaDescription"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
                  <Textarea
                    label={tSeo('metaDescriptionLabel', {
                      count: formData.metaDescription.length,
                    })}
                    value={formData.metaDescription}
                    onChange={e => updateField('metaDescription', e.target.value)}
                    maxLength={180}
                    rows={3}
                  />
                </div>
                <div>
                  <div className="mb-1 flex justify-end">
                    <AiFieldBadge
                      field="metaDescriptionAr"
                      sources={aiSources}
                      storeId={storeId}
                      productId={product?.id}
                      onReset={handleAiReset}
                    />
                  </div>
                  <Textarea
                    label={tSeo('metaDescriptionArLabel', {
                      count: formData.metaDescriptionAr.length,
                    })}
                    value={formData.metaDescriptionAr}
                    onChange={e => updateField('metaDescriptionAr', e.target.value)}
                    maxLength={180}
                    rows={3}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
              </div>
              <div className="col-span-2 border-t border-border pt-4 mt-1">
                <p className="text-xs text-muted-foreground mb-3">
                  {tSeo.rich('aeoExplanation', {
                    b: chunks => <span className="font-medium text-foreground">{chunks}</span>,
                  })}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Textarea
                    label={tSeo('aeoMetaDescriptionEnLabel', {
                      count: formData.metaDescriptionAeo.length,
                    })}
                    value={formData.metaDescriptionAeo}
                    onChange={e => updateField('metaDescriptionAeo', e.target.value)}
                    maxLength={180}
                    rows={3}
                  />
                  <Textarea
                    label={tSeo('aeoMetaDescriptionArLabel', {
                      count: formData.metaDescriptionAeoAr.length,
                    })}
                    value={formData.metaDescriptionAeoAr}
                    onChange={e => updateField('metaDescriptionAeoAr', e.target.value)}
                    maxLength={180}
                    rows={3}
                    lang="ar"
                    dir="rtl"
                  />
                </div>
              </div>
            </div>

            {/* FAQ editor — rendered after product loads. Uses the existing
                /products/:id/faqs CRUD endpoints + AI draft endpoint. */}
            {product && (
              <ProductFaqSection ref={faqSectionRef} storeId={storeId} productId={product.id} />
            )}
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
            badgeLabel={formData.badgeLabel}
            onBadgeLabelChange={value => updateField('badgeLabel', value)}
            badgeLabelAr={formData.badgeLabelAr}
            onBadgeLabelArChange={value => updateField('badgeLabelAr', value)}
            saving={saving}
            // Cancel returns to the LIST (returnTo), not the product view page —
            // the merchant is bailing out of editing back to where they were.
            onCancel={() => router.push(returnTo)}
            storeId={storeId}
            productName={formData.name}
            productDescription={formData.description}
          />
        </div>
      </form>
    </AdminLayout>
  );
}
