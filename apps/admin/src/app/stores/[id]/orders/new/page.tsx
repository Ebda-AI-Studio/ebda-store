'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { useLocale } from 'next-intl';
import { KUWAIT_GOVERNORATES, areasForGovernorate } from '@force/shared';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../../lib/api';
import { formatPrice } from '@/lib/format';

interface ProductVariant {
  id: string;
  title: string;
  titleAr?: string | null;
  price: number;
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
  hasVariants?: boolean;
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
 * button generates a MyFatoorah link. Ahmad 2026-05-16: "land an order
 * from admin and copy the payment link."
 */
export default function NewOrderPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();
  const locale = useLocale();
  const isRtl = locale === 'ar';

  // Customer state — either an existing User.id (selected from search)
  // or guest info typed into the form.
  const [customerMode, setCustomerMode] = useState<'existing' | 'guest'>('guest');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerSearchResult[]>([]);
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
  const [country, setCountry] = useState('Kuwait');
  const [notes, setNotes] = useState('');
  const [couponCode, setCouponCode] = useState('');

  // Shipping preview state (live-computed after governorate+area chosen).
  const [shippingPreview, setShippingPreview] = useState<ShippingPreview | null>(null);
  const [shippingPreviewLoading, setShippingPreviewLoading] = useState(false);

  // Manual fee override. Stored as the raw string the merchant types (KWD),
  // converted to integer fils on submit.
  const [shippingOverrideKwd, setShippingOverrideKwd] = useState('');

  // Product picker state.
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<ProductSearchResult[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  // Variant picker: when a product with variants is selected from the dropdown,
  // it sits here until the merchant picks a variant (or dismisses).
  const [pendingVariantProduct, setPendingVariantProduct] = useState<ProductSearchResult | null>(
    null
  );
  const [loadingVariants, setLoadingVariants] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const debouncedProductSearch = useDebounced(productSearch, 250);
  const debouncedCustomerSearch = useDebounced(customerSearch, 250);

  // Product autocomplete.
  useEffect(() => {
    if (!storeId || debouncedProductSearch.trim().length < 2) {
      setProductResults([]);
      return;
    }
    apiGet<{ products: ProductSearchResult[] }>(
      `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(
        debouncedProductSearch
      )}&limit=10`
    ).then(({ data }) => {
      if (data?.products) setProductResults(data.products);
    });
  }, [storeId, debouncedProductSearch]);

  // Customer autocomplete — search existing User rows. The store's
  // customers list endpoint covers this.
  useEffect(() => {
    if (!storeId || customerMode !== 'existing' || debouncedCustomerSearch.trim().length < 2) {
      setCustomerResults([]);
      return;
    }
    apiGet<{ customers: CustomerSearchResult[] }>(
      `/api/v1/stores/${storeId}/customers/search?q=${encodeURIComponent(debouncedCustomerSearch)}`
    )
      .then(({ data }) => {
        if (data?.customers) setCustomerResults(data.customers);
      })
      .catch(() => setCustomerResults([]));
  }, [storeId, customerMode, debouncedCustomerSearch]);

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
    setProductSearch('');
    setProductResults([]);

    // If the product has variants, fetch them and show the variant picker.
    const hasVariants = p.hasVariants || (p.variants && p.variants.length > 0);
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
          // Fallback: add as parent product without variant if fetch fails.
          const locName = displayName(p.name, p.nameAr);
          setItems(prev => {
            const existing = prev.find(it => it.productId === p.id && !it.variantId);
            if (existing) {
              return prev.map(it =>
                it.productId === p.id && !it.variantId ? { ...it, quantity: it.quantity + 1 } : it
              );
            }
            return [
              ...prev,
              { productId: p.id, productName: locName, unitPrice: p.price, quantity: 1 },
            ];
          });
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
          unitPrice: variant.price,
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
    setCustomerResults([]);
  };

  // When governorate changes, reset area + shipping preview.
  const handleGovernorateChange = (val: string) => {
    setGovernorate(val);
    setArea('');
    setShippingPreview(null);
  };

  // Shipping override in fils (integer). Blank = use calculated.
  const shippingOverrideFils = useMemo(() => {
    const trimmed = shippingOverrideKwd.trim();
    if (!trimmed) return undefined;
    const parsed = parseFloat(trimmed);
    if (isNaN(parsed) || parsed < 0) return undefined;
    return Math.round(parsed * 1000);
  }, [shippingOverrideKwd]);

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) {
      toastError('Add at least one product before placing the order');
      return;
    }
    if (!firstName.trim() || !phone.trim()) {
      toastError('First name and phone are required');
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
      // shippingOverride — integer fils, omitted when blank.
      if (typeof shippingOverrideFils === 'number') {
        payload.shippingOverride = shippingOverrideFils;
      }
      const { data, error: apiError } = await apiPost<{
        order: { id: string; orderNumber: string };
      }>(`/api/v1/stores/${storeId}/orders/admin`, payload);
      if (apiError || !data) {
        toastError('Failed to create order', apiError?.message ?? '');
        return;
      }
      toastSuccess(`Order ${data.order.orderNumber} created`);
      router.push(`/stores/${storeId}/orders/${data.order.id}`);
    } catch (e) {
      toastError('Failed to create order', e instanceof Error ? e.message : 'Unknown error');
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
    shippingOverrideFils,
    router,
    toastSuccess,
    toastError,
  ]);

  // Area options for the currently selected governorate.
  const areaOptions = useMemo(() => areasForGovernorate(governorate), [governorate]);

  return (
    <AdminLayout
      title="New order (phone order)"
      subtitle="Create an order on behalf of a customer, then issue a payment link"
      actions={
        <Link href={`/stores/${storeId}/orders`}>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </Link>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6 pb-24">
        {/* Customer card */}
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Customer
          </h2>
          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setCustomerMode('existing');
                setSelectedCustomerId(null);
              }}
              className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                customerMode === 'existing'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              Existing customer
            </button>
            <button
              type="button"
              onClick={() => {
                setCustomerMode('guest');
                setSelectedCustomerId(null);
                setCustomerSearch('');
              }}
              className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                customerMode === 'guest'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              New / Guest
            </button>
          </div>
          {customerMode === 'existing' && (
            <div className="relative mb-4">
              <input
                type="text"
                placeholder="Search by name, email, or phone…"
                value={customerSearch}
                onChange={e => setCustomerSearch(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {customerResults.length > 0 && (
                <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card shadow-lg">
                  {customerResults.map(c => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => selectCustomer(c)}
                        className="w-full px-3 py-2 text-start text-sm hover:bg-muted"
                      >
                        <span className="font-medium">
                          {c.firstName} {c.lastName || ''}
                        </span>
                        {c.email && <span className="ms-2 text-muted-foreground">{c.email}</span>}
                        {c.phone && (
                          <span className="ms-2 text-muted-foreground" dir="ltr">
                            {c.phone}
                          </span>
                        )}
                        {c.isGuest && (
                          <span className="ms-2 inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                            guest
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {selectedCustomerId && (
                <p className="mt-2 text-xs text-success">
                  ✓ Linked to existing customer {selectedCustomerId.slice(0, 8)}…
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="First name *" value={firstName} onChange={setFirstName} required />
            <Input label="Last name" value={lastName} onChange={setLastName} />
            <Input label="Email" type="email" value={email} onChange={setEmail} dir="ltr" />
            <Input
              label="Phone *"
              type="tel"
              value={phone}
              onChange={setPhone}
              dir="ltr"
              required
            />
          </div>
        </section>

        {/* Shipping address */}
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Shipping address
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Address line"
              value={address1}
              onChange={setAddress1}
              className="sm:col-span-2"
            />

            {/* Governorate select */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Governorate / المحافظة</span>
              <select
                value={governorate}
                onChange={e => handleGovernorateChange(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">— Select governorate —</option>
                {KUWAIT_GOVERNORATES.map(gov => (
                  <option key={gov.en} value={gov.en}>
                    {gov.en} / {gov.ar}
                  </option>
                ))}
              </select>
            </label>

            {/* Area select — filtered by selected governorate */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Area / المنطقة</span>
              <select
                value={area}
                onChange={e => setArea(e.target.value)}
                disabled={!governorate}
                className="rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">
                  {governorate ? '— Select area —' : '— Select governorate first —'}
                </option>
                {areaOptions.map(a => (
                  <option key={a.en} value={a.en}>
                    {a.en} / {a.ar}
                  </option>
                ))}
              </select>
            </label>

            <Input label="Country" value={country} onChange={setCountry} />
          </div>

          {/* Live shipping preview */}
          {(shippingPreview || shippingPreviewLoading) && (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Calculated shipping fee
              </p>
              {shippingPreviewLoading ? (
                <p className="text-muted-foreground">Calculating…</p>
              ) : shippingPreview ? (
                shippingPreview.matched ? (
                  shippingPreview.freeShipping ? (
                    <p className="font-medium text-success">Free delivery</p>
                  ) : (
                    <p className="font-semibold text-foreground">
                      {formatPrice(shippingPreview.shippingCost)}
                      <span className="ms-2 text-xs font-normal text-muted-foreground">
                        (via {shippingPreview.source === 'area-rate' ? 'area rate' : 'zone'})
                      </span>
                    </p>
                  )
                ) : (
                  <p className="text-warning">
                    No rate configured for this area — set a fee below or the order will save with 0
                    KWD shipping.
                  </p>
                )
              ) : null}
            </div>
          )}

          {/* Manual shipping override */}
          <div className="mt-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">
                Shipping fee override (KWD) — leave blank to use the calculated fee
              </span>
              <input
                type="number"
                min="0"
                step="0.001"
                placeholder="e.g. 1.500"
                value={shippingOverrideKwd}
                onChange={e => setShippingOverrideKwd(e.target.value)}
                dir="ltr"
                className="w-48 rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {typeof shippingOverrideFils === 'number' && (
                <p className="text-xs text-primary">
                  Override active: {formatPrice(shippingOverrideFils)} ({shippingOverrideFils} fils)
                  will be used instead of the calculated fee.
                </p>
              )}
            </label>
          </div>
        </section>

        {/* Products */}
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Products
          </h2>
          <div className="relative mb-4">
            <input
              type="text"
              placeholder="Search products by name or SKU…"
              value={productSearch}
              onChange={e => setProductSearch(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {productResults.length > 0 && (
              <ul className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-card shadow-lg">
                {productResults.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => addProduct(p)}
                      className="w-full px-3 py-2 text-start text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{displayName(p.name, p.nameAr)}</span>
                      {p.sku && <span className="ms-2 text-xs text-muted-foreground">{p.sku}</span>}
                      <span className="ms-2 text-muted-foreground">{formatPrice(p.price)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loadingVariants && (
              <p className="mt-2 text-xs text-muted-foreground">Loading variants…</p>
            )}
            {/* Variant picker — shown inline after merchant picks a variant product */}
            {pendingVariantProduct && (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  {displayName(pendingVariantProduct.name, pendingVariantProduct.nameAr)} — choose a
                  variant:
                </p>
                <div className="flex flex-wrap gap-2">
                  {(pendingVariantProduct.variants ?? [])
                    .filter(v => v.isActive)
                    .map(v => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => addVariant(pendingVariantProduct, v)}
                        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/5 hover:border-primary/40 transition-colors"
                      >
                        {isRtl ? v.titleAr || v.title : v.title || v.titleAr || v.title}
                        <span className="ms-1.5 text-muted-foreground">{formatPrice(v.price)}</span>
                        {v.inventory <= 0 && (
                          <span className="ms-1.5 text-destructive/70 text-[10px]">
                            (out of stock)
                          </span>
                        )}
                      </button>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => setPendingVariantProduct(null)}
                  className="mt-2 text-xs text-muted-foreground underline"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg bg-muted/30 p-4 text-center text-sm text-muted-foreground">
              No products yet. Search above to add the first item.
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
                    className="w-16 rounded border border-border bg-background px-2 py-1 text-center text-sm"
                  />
                  <span className="w-24 text-end font-semibold text-foreground">
                    {formatPrice(it.unitPrice * it.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeItem(it.productId, it.variantId)}
                    aria-label="Remove"
                    className="rounded p-1 text-destructive hover:bg-destructive/10"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center justify-end gap-3 text-sm">
            <span className="text-muted-foreground">Subtotal:</span>
            <span className="text-lg font-bold text-foreground">{formatPrice(subtotal)}</span>
          </div>
          {/* Show projected total when shipping is known */}
          {(shippingPreview?.matched || typeof shippingOverrideFils === 'number') && (
            <div className="mt-1 flex items-center justify-end gap-3 text-sm">
              <span className="text-muted-foreground">Shipping:</span>
              <span className="font-medium text-foreground">
                {typeof shippingOverrideFils === 'number'
                  ? `${formatPrice(shippingOverrideFils)} (override)`
                  : shippingPreview?.freeShipping
                    ? 'Free'
                    : formatPrice(shippingPreview!.shippingCost)}
              </span>
            </div>
          )}
          <p className="mt-1 text-end text-xs text-muted-foreground">
            {governorate && area
              ? 'Shipping fee shown is a preview — tax is calculated on save.'
              : 'Select governorate + area above to preview the shipping fee.'}
          </p>
        </section>

        {/* Notes + coupon */}
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Coupon code (optional)" value={couponCode} onChange={setCouponCode} />
            <Input label="Notes (optional)" value={notes} onChange={setNotes} />
          </div>
        </section>

        {/* Submit footer — lifted above the fixed MobileBottomNav (h-14 =
            56px) + safe-area on mobile so it isn't hidden behind it; rule 6
            "fixed-bottom UI" recipe. md:bottom-0 because the nav is
            md:hidden (desktop = sidebar). */}
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0 -mx-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:bg-card sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {items.length} item{items.length === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-foreground">{formatPrice(subtotal)}</span>
            </p>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || items.length === 0}
            >
              {isSubmitting ? 'Creating…' : 'Place order'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Order created in unpaid state. Issue a MyFatoorah payment link from the order detail
            page after save.
          </p>
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
        className="rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}
