'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../../lib/api';

interface ProductSearchResult {
  id: string;
  name: string;
  nameAr?: string;
  price: number;
  sku?: string;
}

interface LineItem {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

interface CustomerSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
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
  const [city, setCity] = useState('');
  const [area, setArea] = useState('');
  const [country, setCountry] = useState('Kuwait');
  const [notes, setNotes] = useState('');
  const [couponCode, setCouponCode] = useState('');

  // Product picker state.
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<ProductSearchResult[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);

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
      `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(debouncedProductSearch)}&limit=10`
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

  const addProduct = (p: ProductSearchResult) => {
    setItems(prev => {
      const existing = prev.find(it => it.productId === p.id);
      if (existing) {
        return prev.map(it => (it.productId === p.id ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, { productId: p.id, productName: p.name, unitPrice: p.price, quantity: 1 }];
    });
    setProductSearch('');
    setProductResults([]);
  };

  const removeItem = (productId: string) => {
    setItems(prev => prev.filter(it => it.productId !== productId));
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity < 1) return removeItem(productId);
    setItems(prev => prev.map(it => (it.productId === productId ? { ...it, quantity } : it)));
  };

  const selectCustomer = (c: CustomerSearchResult) => {
    setSelectedCustomerId(c.id);
    setFirstName(c.firstName);
    setLastName(c.lastName);
    setEmail(c.email);
    setPhone(c.phone ?? '');
    setCustomerSearch(`${c.firstName} ${c.lastName} <${c.email}>`);
    setCustomerResults([]);
  };

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
      const payload = {
        customerId: customerMode === 'existing' ? selectedCustomerId : undefined,
        shippingAddress: {
          firstName,
          lastName,
          email,
          phone,
          address1,
          city,
          area,
          country,
        },
        items: items.map(it => ({ productId: it.productId, quantity: it.quantity })),
        notes: notes || undefined,
        couponCode: couponCode || undefined,
      };
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
    city,
    area,
    country,
    items,
    notes,
    couponCode,
    router,
    toastSuccess,
    toastError,
  ]);

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
                <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-popover shadow-lg">
                  {customerResults.map(c => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => selectCustomer(c)}
                        className="w-full px-3 py-2 text-start text-sm hover:bg-muted"
                      >
                        <span className="font-medium">
                          {c.firstName} {c.lastName}
                        </span>
                        <span className="ms-2 text-muted-foreground">{c.email}</span>
                        {c.phone && (
                          <span className="ms-2 text-muted-foreground" dir="ltr">
                            {c.phone}
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
            <Input label="Area / Block" value={area} onChange={setArea} />
            <Input label="City" value={city} onChange={setCity} />
            <Input label="Country" value={country} onChange={setCountry} />
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
              <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-popover shadow-lg">
                {productResults.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => addProduct(p)}
                      className="w-full px-3 py-2 text-start text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{p.name}</span>
                      {p.sku && <span className="ms-2 text-xs text-muted-foreground">{p.sku}</span>}
                      <span className="ms-2 text-muted-foreground">
                        {(p.price / 1000).toFixed(3)} KWD
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg bg-muted/30 p-4 text-center text-sm text-muted-foreground">
              No products yet. Search above to add the first item.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map(it => (
                <li key={it.productId} className="flex items-center gap-3 p-3 text-sm">
                  <span className="flex-1 font-medium text-foreground">{it.productName}</span>
                  <span className="text-xs text-muted-foreground">
                    {(it.unitPrice / 1000).toFixed(3)} KWD
                  </span>
                  <input
                    type="number"
                    min="1"
                    value={it.quantity}
                    onChange={e => updateQuantity(it.productId, Number(e.target.value))}
                    className="w-16 rounded border border-border bg-background px-2 py-1 text-center text-sm"
                  />
                  <span className="w-24 text-end font-semibold text-foreground">
                    {((it.unitPrice * it.quantity) / 1000).toFixed(3)} KWD
                  </span>
                  <button
                    type="button"
                    onClick={() => removeItem(it.productId)}
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
            <span className="text-lg font-bold text-foreground">
              {(subtotal / 1000).toFixed(3)} KWD
            </span>
          </div>
          <p className="mt-1 text-end text-xs text-muted-foreground">
            Tax + shipping calculated on save based on store config.
          </p>
        </section>

        {/* Notes + coupon */}
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Coupon code (optional)" value={couponCode} onChange={setCouponCode} />
            <Input label="Notes (optional)" value={notes} onChange={setNotes} />
          </div>
        </section>

        {/* Submit footer */}
        <div className="sticky bottom-0 -mx-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:bg-card sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {items.length} item{items.length === 1 ? '' : 's'} ·{' '}
              <span className="font-semibold text-foreground">
                {(subtotal / 1000).toFixed(3)} KWD
              </span>
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
