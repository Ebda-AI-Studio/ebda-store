'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { SearchPicker } from '@/components/SearchPicker';
import { useLocale } from 'next-intl';
import {
  EGYPT_GOVERNORATES,
  areasForGovernorate,
  roundToMinor,
  REGION,
  searchQueryHeaders,
} from '@ebda/shared';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../../lib/api';
import { isVariantProduct } from '../../../../../lib/variant-product';
import { useAuth } from '../../../../../lib/auth';
import { formatPrice } from '@/lib/format';
import { useT } from '@/i18n/useT';
import { effectiveVariantPrice } from '@/lib/variant-price';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface ProductVariant {
  id: string;
  title: string;
  titleAr?: string | null;
  /** Override price; null = inherits the product price (schema: Int?). */
  price: number | null;
  inventory: number;
  sku?: string | null;
  isActive: boolean;
}

interface ProductSearchResult {
  id: string;
  name: string;
  nameAr?: string;
  price: number;
  sku?: string;
  /** Column; can drift from the rows. `variantCount` (every row) wins when present. */
  hasVariants?: boolean;
  variantCount?: number;
  variants?: ProductVariant[];
}

interface LineItem {
  productId: string;
  variantId?: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

interface CustomerSearchResult {
  /** UUID for registered customers, `guest:<key>` for past guests. */
  id: string;
  /** True when sourced from order.shippingAddress (no User row). */
  isGuest?: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

interface ShippingPreview {
  shippingCost: number;
  freeShipping: boolean;
  matched: boolean;
  source: 'area-rate' | 'zone' | 'none';
}

/**
 * Admin-side order creation. Phone-order MVP — merchant enters customer
 * info + picks products via search + sets quantities, submits. After
 * save lands on the order detail page where the existing "Payment Link"
 * button generates a payment link. Ahmad 2026-05-16: "land an order
 * from admin and copy the payment link."
 */
export default function NewOrderPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();
  const locale = useLocale();
  const isRtl = locale === 'ar';
  const t = useT('orders.new');
  const { user } = useAuth();
  const canOverrideCoupon = user?.role === 'store_admin' || user?.role === 'super_admin';
  const tCommon = useT('common');

  // Customer state — either an existing User.id (selected from search)
  // or guest info typed into the form.
  const [customerMode, setCustomerMode] = useState<'existing' | 'guest'>('guest');
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address1, setAddress1] = useState('');
  // Governorate + area come from the cascade selects.
  // "city" is kept for backward-compat with any downstream display
  // that reads shippingAddress.city, but it mirrors the governorate.
  const [governorate, setGovernorate] = useState('');
  const [area, setArea] = useState('');
  const [country, setCountry] = useState(REGION.countryName.en);
  const [notes, setNotes] = useState('');
  const [couponCode, setCouponCode] = useState('');
  // Coupon rules are ENFORCED by default (#1370). A store admin may override
  // them with a reason; the API rejects the flag for staff (403).
  const [overrideCouponRules, setOverrideCouponRules] = useState(false);
  const [couponOverrideReason, setCouponOverrideReason] = useState('');

  // Shipping preview state (live-computed after governorate+area chosen).
  const [shippingPreview, setShippingPreview] = useState<ShippingPreview | null>(null);
  const [shippingPreviewLoading, setShippingPreviewLoading] = useState(false);

  // Manual fee override. Stored as the raw string the merchant types (EGP),
  // converted to integer piastres on submit.
  const [shippingOverrideMajor, setShippingOverrideMajor] = useState('');

  // Product picker state.
  const [items, setItems] = useState<LineItem[]>([]);
  // Variant picker: when a product with variants is selected from the dropdown,
  // it sits here until the merchant picks a variant (or dismisses).
  const [pendingVariantProduct, setPendingVariantProduct] = useState<ProductSearchResult | null>(
    null
  );
  const [loadingVariants, setLoadingVariants] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Product + customer pickers: search-as-you-type (SearchPicker aborts the superseded request).
  const searchProducts = useCallback(
    async (q: string, signal: AbortSignal) => {
      const { data, error } = await apiGet<{ products: ProductSearchResult[] }>(
        `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=10`,
        undefined,
        signal
      );
      if (error) throw new Error(error.message);
      return data?.products ?? [];
    },
    [storeId]
  );
  // Customer search — existing User rows. The store's customers list endpoint covers this.
  const searchCustomers = useCallback(
    async (q: string, signal: AbortSignal) => {
      const { data, error } = await apiGet<{ customers: CustomerSearchResult[] }>(
        `/api/v1/stores/${storeId}/customers/search`,
        searchQueryHeaders(q),
        signal
      );
      if (error) throw new Error(error.message);
      return data?.customers ?? [];
    },
    [storeId]
  );

  const subtotal = useMemo(
    () => items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0),
    [items]
  );

  // Live shipping preview — fires whenever governorate+area are both set.
  // Uses the public shipping-calculate endpoint (no auth required):
  //   POST /api/v1/stores/public/:storeId/shipping/calculate
  //   Body: { area: string, orderTotal: number, governorate: string }
  //   Response: { success: true, data: { shippingCost, freeShipping, matched, source } }
  // Note: admin apiPost prepends NEXT_PUBLIC_API_URL (no /api/v1 suffix),
  // so we include /api/v1 in the path ourselves.
  const debouncedArea = useDebounced(area, 300);
  useEffect(() => {
    if (!storeId || !governorate || !debouncedArea) {
      setShippingPreview(null);
      return;
    }
    let cancelled = false;
    setShippingPreviewLoading(true);
    // apiPost unwraps the `{ success, data, error }` envelope:
    // the returned `data` IS the inner `data` object from the response.
    apiPost<ShippingPreview>(`/api/v1/stores/public/${storeId}/shipping/calculate`, {
      area: debouncedArea,
      orderTotal: subtotal,
      governorate,
    })
      .then(({ data, error }) => {
        if (cancelled) return;
        setShippingPreviewLoading(false);
        if (!error && data) {
          setShippingPreview(data);
        } else {
          setShippingPreview(null);
        }
      })
      .catch(() => {
        if (!cancelled) setShippingPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, governorate, debouncedArea, subtotal]);

  const displayName = (name: string, nameAr?: string | null) =>
    isRtl ? nameAr || name : name || nameAr || name;

  const addProduct = async (p: ProductSearchResult) => {
    // If the product has variants, fetch them and show the variant picker.
    // The API's rule (any variant row), not the column (W1a re-review minor 4).
    const hasVariants = isVariantProduct(p) || (p.variants?.length ?? 0) > 0;
    if (hasVariants) {
      if (p.variants && p.variants.length > 0) {
        // Already have variants in the search result — go straight to picker.
        setPendingVariantProduct(p);
      } else {
        // Need to fetch variants from the dedicated variant endpoint.
        setLoadingVariants(true);
        try {
          // The endpoint returns `{ product, options, variants }` with the
          // variants at the TOP level (same shape the variants page reads).
          // Reading `product.variants` always gave [] and an empty picker.
          const { data } = await apiGet<{
            variants: ProductVariant[];
          }>(`/api/v1/stores/${storeId}/products/${p.id}/variants`);
          const variants = data?.variants ?? [];
          setPendingVariantProduct({ ...p, variants });
        } catch {
          // No bare-parent fallback: a product with variants is ordered as one
          // of them (C-01) and the API refuses it without one (VARIANT_REQUIRED).
          toastError(t('errors.variantsLoadFailed'));
        } finally {
          setLoadingVariants(false);
        }
      }
      return;
    }

    // No variants — add directly with locale-aware name.
    const locName = displayName(p.name, p.nameAr);
    setItems(prev => {
      const existing = prev.find(it => it.productId === p.id && !it.variantId);
      if (existing) {
        return prev.map(it =>
          it.productId === p.id && !it.variantId ? { ...it, quantity: it.quantity + 1 } : it
        );
      }
      return [...prev, { productId: p.id, productName: locName, unitPrice: p.price, quantity: 1 }];
    });
  };

  const addVariant = (product: ProductSearchResult, variant: ProductVariant) => {
    const productLocName = displayName(product.name, product.nameAr);
    const variantLocName = isRtl
      ? variant.titleAr || variant.title
      : variant.title || variant.titleAr || variant.title;
    const lineItemName = `${productLocName} — ${variantLocName}`;
    setItems(prev => {
      const existing = prev.find(it => it.productId === product.id && it.variantId === variant.id);
      if (existing) {
        return prev.map(it =>
          it.productId === product.id && it.variantId === variant.id
            ? { ...it, quantity: it.quantity + 1 }
            : it
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          variantId: variant.id,
          productName: lineItemName,
          unitPrice: effectiveVariantPrice(variant.price, product.price),
          quantity: 1,
        },
      ];
    });
    setPendingVariantProduct(null);
  };

  const removeItem = (productId: string, variantId?: string) => {
    setItems(prev =>
      prev.filter(it => !(it.productId === productId && it.variantId === variantId))
    );
  };

  const updateQuantity = (productId: string, quantity: number, variantId?: string) => {
    if (quantity < 1) return removeItem(productId, variantId);
    setItems(prev =>
      prev.map(it =>
        it.productId === productId && it.variantId === variantId ? { ...it, quantity } : it
      )
    );
  };

  const selectCustomer = (c: CustomerSearchResult) => {
    // Guest matches don't attach a User row — only pre-fill the form
    // and leave customerId null so the new order persists as guest.
    // Registered matches attach via the UUID.
    setSelectedCustomerId(c.isGuest ? null : c.id);
    setFirstName(c.firstName);
    setLastName(c.lastName);
    setEmail(c.email);
    setPhone(c.phone ?? '');
    setCustomerSearch(
      c.isGuest
        ? `${c.firstName} ${c.lastName} <${c.email || c.phone}> (guest)`
        : `${c.firstName} ${c.lastName} <${c.email}>`
    );
  };

  // When governorate changes, reset area + shipping preview.
  const handleGovernorateChange = (val: string) => {
    setGovernorate(val);
    setArea('');
    setShippingPreview(null);
  };

  // Shipping override in piastres (integer). Blank = use calculated.
  const shippingOverrideFils = useMemo(() => {
    const trimmed = shippingOverrideMajor.trim();
    if (!trimmed) return undefined;
    const parsed = parseFloat(trimmed);
    if (isNaN(parsed) || parsed < 0) return undefined;
    return roundToMinor(parsed);
  }, [shippingOverrideMajor]);

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) {
      toastError(t('errors.noItems'));
      return;
    }
    if (!firstName.trim() || !phone.trim()) {
      toastError(t('errors.missingRequired'));
      return;
    }
    const overriding = canOverrideCoupon && overrideCouponRules && !!couponCode.trim();
    if (overriding && couponOverrideReason.trim().length < 3) {
      toastError(t('errors.overrideReasonRequired'));
      return;
    }
    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        customerId: customerMode === 'existing' ? selectedCustomerId : undefined,
        shippingAddress: {
          firstName,
          lastName,
          email,
          phone,
          address1,
          // city mirrors governorate for downstream display compatibility.
          city: governorate,
          area,
          governorate,
          country,
        },
        items: items.map(it => ({
          productId: it.productId,
          quantity: it.quantity,
          ...(it.variantId ? { variantId: it.variantId } : {}),
        })),
        notes: notes || undefined,
        couponCode: couponCode || undefined,
      };
      if (overriding) {
        payload.overrideCouponRules = true;
        payload.couponOverrideReason = couponOverrideReason.trim();
      }
      // shippingOverride — integer piastres, omitted when blank.
      if (typeof shippingOverrideFils === 'number') {
        payload.shippingOverride = shippingOverrideFils;
      }
      const { data, error: apiError } = await apiPost<{
        order: { id: string; orderNumber: string };
      }>(`/api/v1/stores/${storeId}/orders/admin`, payload);
      if (apiError || !data) {
        toastError(
          t('errors.createFailed'),
          apiError?.code === 'VARIANT_REQUIRED'
            ? t('errors.variantRequired')
            : apiError?.code === 'VARIANT_INACTIVE'
              ? t('errors.variantInactive')
              : (apiError?.message ?? '')
        );
        return;
      }
      toastSuccess(t('toast.created', { orderNumber: data.order.orderNumber }));
      router.push(`/stores/${storeId}/orders/${data.order.id}`);
    } catch (e) {
      toastError(
        t('errors.createFailed'),
        e instanceof Error ? e.message : t('errors.unknownError')
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    storeId,
    customerMode,
    selectedCustomerId,
    firstName,
    lastName,
    email,
    phone,
    address1,
    governorate,
    area,
    country,
    items,
    notes,
    couponCode,
    canOverrideCoupon,
    overrideCouponRules,
    couponOverrideReason,
    shippingOverrideFils,
    router,
    toastSuccess,
    toastError,
    t,
  ]);

  // Area options for the currently selected governorate.
  const areaOptions = useMemo(() => areasForGovernorate(governorate), [governorate]);

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Link href={`/stores/${storeId}/orders`}>
          <Button type="button" variant="outline">
            {tCommon('cancel')}
          </Button>
        </Link>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6 pb-24">
        {/* Customer card */}
        <section className="rounded-md border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('customerSection.heading')}
          </h2>
          <div className="mb-4 flex gap-2">
            <Button
              type="button"
              onClick={() => {
                setCustomerMode('existing');
                setSelectedCustomerId(null);
              }}
              variant={customerMode === 'existing' ? 'soft' : 'ghost'}
              className="flex-1"
            >
              {t('customerSection.existingTab')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setCustomerMode('guest');
                setSelectedCustomerId(null);
                setCustomerSearch('');
              }}
              variant={customerMode === 'guest' ? 'soft' : 'ghost'}
              className="flex-1"
            >
              {t('customerSection.guestTab')}
            </Button>
          </div>
          {customerMode === 'existing' && (
            <div className="relative mb-4">
              <SearchPicker<CustomerSearchResult>
                value={customerSearch}
                onValueChange={setCustomerSearch}
                search={searchCustomers}
                getKey={c => c.id}
                onPick={selectCustomer}
                placeholder={t('customerSection.searchPlaceholder')}
                renderOption={(c, hl) => (
                  <>
                    <span className="font-medium">
                      {hl(`${c.firstName} ${c.lastName || ''}`.trim())}
                    </span>
                    {c.email && <span className="ms-2 text-muted-foreground">{hl(c.email)}</span>}
                    {c.phone && (
                      <span className="ms-2 text-muted-foreground" dir="ltr">
                        {hl(c.phone)}
                      </span>
                    )}
                    {c.isGuest && (
                      <span className="ms-2 inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
                        {t('customerSection.guestBadge')}
                      </span>
                    )}
                  </>
                )}
              />
              {selectedCustomerId && (
                <p className="mt-2 text-xs text-success-ink">
                  ✓{' '}
                  {t('customerSection.linkedToCustomer', {
                    id: selectedCustomerId.slice(0, 8),
                  })}
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('customerSection.firstNameLabel')}
              value={firstName}
              onChange={setFirstName}
              required
            />
            <Input
              label={t('customerSection.lastNameLabel')}
              value={lastName}
              onChange={setLastName}
            />
            <Input
              label={t('customerSection.emailLabel')}
              type="email"
              value={email}
              onChange={setEmail}
              dir="ltr"
            />
            <Input
              label={t('customerSection.phoneLabel')}
              type="tel"
              value={phone}
              onChange={setPhone}
              dir="ltr"
              required
            />
          </div>
        </section>

        {/* Shipping address */}
        <section className="rounded-md border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('shippingSection.heading')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('shippingSection.addressLabel')}
              value={address1}
              onChange={setAddress1}
              className="sm:col-span-2"
            />

            {/* Governorate select */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('shippingSection.governorateLabel')}</span>
              <select
                value={governorate}
                onChange={e => handleGovernorateChange(e.target.value)}
                className={FIELD_CLASSES}
              >
                <option value="">{t('shippingSection.selectGovernoratePlaceholder')}</option>
                {/* Governorate names are shown in both languages together on purpose —
                    the merchant and the delivery driver may read different locales,
                    so this bilingual place-name data is not swapped by admin locale. */}
                {EGYPT_GOVERNORATES.map(gov => (
                  <option key={gov.en} value={gov.en}>
                    {gov.en} / {gov.ar}
                  </option>
                ))}
              </select>
            </label>

            {/* Area select — filtered by selected governorate */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('shippingSection.areaLabel')}</span>
              <select
                value={area}
                onChange={e => setArea(e.target.value)}
                disabled={!governorate}
                className={`${FIELD_CLASSES} disabled:cursor-not-allowed`}
              >
                <option value="">
                  {governorate
                    ? t('shippingSection.selectAreaPlaceholder')
                    : t('shippingSection.selectGovernorateFirstPlaceholder')}
                </option>
                {/* Same bilingual-by-design data as governorate above. */}
                {areaOptions.map(a => (
                  <option key={a.en} value={a.en}>
                    {a.en} / {a.ar}
                  </option>
                ))}
              </select>
            </label>

            <Input
              label={t('shippingSection.countryLabel')}
              value={country}
              onChange={setCountry}
            />
          </div>

          {/* Live shipping preview */}
          {(shippingPreview || shippingPreviewLoading) && (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('shippingSection.calculatedFeeTitle')}
              </p>
              {shippingPreviewLoading ? (
                <p className="text-muted-foreground">{t('shippingSection.calculating')}</p>
              ) : shippingPreview ? (
                shippingPreview.matched ? (
                  shippingPreview.freeShipping ? (
                    <p className="font-medium text-success-ink">
                      {t('shippingSection.freeDelivery')}
                    </p>
                  ) : (
                    <p className="font-semibold text-foreground">
                      {formatPrice(shippingPreview.shippingCost)}
                      <span className="ms-2 text-xs font-normal text-muted-foreground">
                        {t('shippingSection.viaSource', {
                          source:
                            shippingPreview.source === 'area-rate'
                              ? t('shippingSection.viaAreaRate')
                              : t('shippingSection.viaZone'),
                        })}
                      </span>
                    </p>
                  )
                ) : (
                  <p className="text-warning-ink">{t('shippingSection.noRateConfigured')}</p>
                )
              ) : null}
            </div>
          )}

          {/* Manual shipping override */}
          <div className="mt-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('shippingSection.overrideLabel')}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder={t('shippingSection.overridePlaceholder')}
                value={shippingOverrideMajor}
                onChange={e => setShippingOverrideMajor(e.target.value)}
                dir="ltr"
                className={`${FIELD_CLASSES} w-48`}
              />
              {typeof shippingOverrideFils === 'number' && (
                <p className="text-xs text-primary">
                  {t('shippingSection.overrideActive', {
                    price: formatPrice(shippingOverrideFils),
                  })}
                </p>
              )}
            </label>
          </div>
        </section>

        {/* Products */}
        <section className="rounded-md border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('productsSection.heading')}
          </h2>
          <div className="relative mb-4">
            <SearchPicker<ProductSearchResult>
              search={searchProducts}
              getKey={p => p.id}
              onPick={addProduct}
              placeholder={t('productsSection.searchPlaceholder')}
              renderOption={(p, hl) => (
                <>
                  <span className="font-medium">{hl(displayName(p.name, p.nameAr))}</span>
                  {p.sku && <span className="ms-2 text-xs text-muted-foreground">{hl(p.sku)}</span>}
                  <span className="ms-2 text-muted-foreground">{formatPrice(p.price)}</span>
                </>
              )}
            />
            {loadingVariants && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('productsSection.loadingVariants')}
              </p>
            )}
            {/* Variant picker — shown inline after merchant picks a variant product */}
            {pendingVariantProduct && (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  {t('productsSection.chooseVariantPrompt', {
                    name: displayName(pendingVariantProduct.name, pendingVariantProduct.nameAr),
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(pendingVariantProduct.variants ?? [])
                    .filter(v => v.isActive)
                    .map(v => (
                      <Button
                        key={v.id}
                        type="button"
                        onClick={() => addVariant(pendingVariantProduct, v)}
                        variant="outline"
                        size="sm"
                      >
                        {isRtl ? v.titleAr || v.title : v.title || v.titleAr || v.title}
                        <span className="ms-1.5 text-muted-foreground">
                          {formatPrice(effectiveVariantPrice(v.price, pendingVariantProduct.price))}
                        </span>
                        {v.inventory <= 0 && (
                          <span className="ms-1.5 text-destructive-ink text-xs">
                            {t('productsSection.outOfStock')}
                          </span>
                        )}
                      </Button>
                    ))}
                </div>
                <Button
                  type="button"
                  onClick={() => setPendingVariantProduct(null)}
                  variant="link"
                  size="sm"
                  className="mt-2 text-muted-foreground"
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            )}
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg bg-muted/30 p-4 text-center text-sm text-muted-foreground">
              {t('productsSection.noProductsYet')}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map(it => (
                <li
                  key={`${it.productId}-${it.variantId ?? 'base'}`}
                  className="flex items-center gap-3 p-3 text-sm"
                >
                  <span className="flex-1 font-medium text-foreground">{it.productName}</span>
                  <span className="text-xs text-muted-foreground">{formatPrice(it.unitPrice)}</span>
                  <input
                    type="number"
                    min="1"
                    value={it.quantity}
                    onChange={e =>
                      updateQuantity(it.productId, Number(e.target.value), it.variantId)
                    }
                    className={`${FIELD_CLASSES} w-16 text-center`}
                  />
                  <span className="w-24 text-end font-semibold text-foreground">
                    {formatPrice(it.unitPrice * it.quantity)}
                  </span>
                  <Button
                    type="button"
                    onClick={() => removeItem(it.productId, it.variantId)}
                    aria-label={t('productsSection.removeItemAria')}
                    className="text-destructive-ink"
                    variant="ghost"
                    size="icon-sm"
                  >
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center justify-end gap-3 text-sm">
            <span className="text-muted-foreground">{t('productsSection.subtotalLabel')}</span>
            <span className="text-lg font-bold text-foreground">{formatPrice(subtotal)}</span>
          </div>
          {/* Show projected total when shipping is known */}
          {(shippingPreview?.matched || typeof shippingOverrideFils === 'number') && (
            <div className="mt-1 flex items-center justify-end gap-3 text-sm">
              <span className="text-muted-foreground">{t('productsSection.shippingLabel')}</span>
              <span className="font-medium text-foreground">
                {typeof shippingOverrideFils === 'number'
                  ? `${formatPrice(shippingOverrideFils)} ${t('productsSection.overrideSuffix')}`
                  : shippingPreview?.freeShipping
                    ? t('productsSection.freeShort')
                    : formatPrice(shippingPreview!.shippingCost)}
              </span>
            </div>
          )}
          <p className="mt-1 text-end text-xs text-muted-foreground">
            {governorate && area
              ? t('productsSection.previewHintReady')
              : t('productsSection.previewHintPending')}
          </p>
        </section>

        {/* Notes + coupon */}
        <section className="rounded-md border bg-card p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('notesSection.couponLabel')}
              value={couponCode}
              onChange={setCouponCode}
            />
            <Input label={t('notesSection.notesLabel')} value={notes} onChange={setNotes} />
          </div>
          {canOverrideCoupon && couponCode.trim() && (
            <div className="mt-3 flex flex-col gap-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overrideCouponRules}
                  onChange={e => setOverrideCouponRules(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-md border-border"
                />
                <span>
                  <span className="font-medium text-foreground">
                    {t('notesSection.overrideLabel')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('notesSection.overrideHint')}
                  </span>
                </span>
              </label>
              {overrideCouponRules && (
                <Input
                  label={t('notesSection.overrideReasonLabel')}
                  value={couponOverrideReason}
                  onChange={setCouponOverrideReason}
                  required
                />
              )}
            </div>
          )}
        </section>

        {/* Submit footer — lifted above the fixed MobileBottomNav (h-14 =
            56px) + safe-area on mobile so it isn't hidden behind it; rule 6
            "fixed-bottom UI" recipe. md:bottom-0 because the nav is
            md:hidden (desktop = sidebar). */}
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0 -mx-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border sm:bg-card sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t('footer.itemCount', { count: items.length })} ·{' '}
              <span className="font-semibold text-foreground">{formatPrice(subtotal)}</span>
            </p>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || items.length === 0}
            >
              {isSubmitting ? t('footer.creating') : t('footer.placeOrder')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('footer.unpaidHint')}</p>
        </div>
      </div>
    </AdminLayout>
  );
}

// Tiny debounce hook to throttle autocomplete calls.
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface InputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  className?: string;
  dir?: 'ltr' | 'rtl';
}

function Input({ label, value, onChange, type = 'text', required, className, dir }: InputProps) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        dir={dir}
        className={FIELD_CLASSES}
      />
    </label>
  );
}
