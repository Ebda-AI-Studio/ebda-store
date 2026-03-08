'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { Header, Footer } from '../../components';
import { useCart } from '../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '@/lib/api';

function formatPrice(kwd: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(kwd);
}

export default function CartPage() {
  const {
    items: cartItems,
    updateQuantity: updateCartQuantity,
    removeItem: removeCartItem,
    itemCount,
    total: cartTotal,
  } = useCart();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoName, setPromoName] = useState('');
  const [promoType, setPromoType] = useState('');
  const [promoValue, setPromoValue] = useState(0);
  const [isValidating, setIsValidating] = useState(false);
  const [shippingFee, setShippingFee] = useState(2500); // default 2.5 KWD in fils
  const [freeShippingThreshold, setFreeShippingThreshold] = useState(20000); // default 20 KWD in fils
  const [shippingLoaded, setShippingLoaded] = useState(false);
  const { info, success, error: errorToast } = useToast();

  const handleUpdateQuantity = (itemId: string, newQuantity: number) => {
    const item = cartItems.find(i => i.id === itemId);
    if (newQuantity < 1) {
      removeCartItem(itemId);
      if (item) {
        info('Item removed', `${item.name} removed from cart`);
      }
    } else if (newQuantity > 10) {
      info('Limit reached', 'Maximum 10 items per product');
    } else {
      updateCartQuantity(itemId, newQuantity);
    }
  };

  const handleRemoveItem = (itemId: string) => {
    const item = cartItems.find(i => i.id === itemId);
    removeCartItem(itemId);
    if (item) {
      info('Item removed', `${item.name} removed from cart`);
    }
  };

  const applyPromoCode = useCallback(async () => {
    if (!promoCode.trim() || isValidating) return;
    setIsValidating(true);
    try {
      const result = await api.post<{
        coupon: { id: string; code: string; name: string; type: string; value: number };
        discount: number;
      }>(`/stores/public/${store.id}/coupons/validate`, {
        code: promoCode,
        orderTotal: cartTotal,
      });
      if (result.success && result.data) {
        setPromoApplied(true);
        setPromoDiscount(result.data.discount);
        setPromoName(result.data.coupon.name);
        setPromoType(result.data.coupon.type);
        setPromoValue(result.data.coupon.value);
        success('Promo applied', `${result.data.coupon.name} discount has been applied`);
      } else {
        const message = result.error?.message || 'The promo code is not valid';
        info('Invalid code', message);
      }
    } catch {
      errorToast('Error', 'Failed to validate promo code. Please try again.');
    } finally {
      setIsValidating(false);
    }
  }, [promoCode, isValidating, store.id, cartTotal, success, info, errorToast]);

  // Fetch shipping zones on mount
  useEffect(() => {
    async function fetchShipping() {
      try {
        const result = await api.get<{
          zones: Array<{
            deliveryFee: number;
            freeShippingThreshold: number;
            name: string;
            isActive?: boolean;
          }>;
        }>(`/stores/public/${store.id}/shipping`);
        if (result.success && result.data?.zones?.length) {
          const activeZone =
            result.data.zones.find(z => z.isActive !== false) || result.data.zones[0];
          setShippingFee(activeZone.deliveryFee);
          setFreeShippingThreshold(activeZone.freeShippingThreshold);
          setShippingLoaded(true);
        }
      } catch {
        // Fall back to default shipping values
      }
    }
    if (store.id) {
      fetchShipping();
    }
  }, [store.id]);

  // Convert from fils to KWD (price is stored in fils, 1 KWD = 1000 fils)
  const subtotal = cartTotal / 1000;
  const discount = promoApplied ? promoDiscount / 1000 : 0;
  const shipping = shippingLoaded
    ? cartTotal >= freeShippingThreshold
      ? 0
      : shippingFee / 1000
    : subtotal >= 20
      ? 0
      : 2.5;
  const total = subtotal - discount + shipping;
  const cartCount = itemCount;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header cartCount={cartCount} />

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={storeUrl('/')} className="transition-colors hover:text-primary">
            {t('Home', translations['Home'])}
          </Link>
          <svg
            className={`h-4 w-4 ${language === 'ar' ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-foreground">{t('Shopping Cart', 'سلة التسوق')}</span>
        </nav>

        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          {t('Shopping Cart', 'سلة التسوق')}
        </h1>
        {cartItems.length > 0 && (
          <p className="mt-2 text-muted-foreground">
            {cartCount} {t('items', 'منتجات')} {t('in your cart', 'في سلتك')}
          </p>
        )}

        {cartItems.length === 0 ? (
          <div className="mt-16 flex flex-col items-center justify-center py-12">
            <div className="mb-6 flex h-32 w-32 items-center justify-center rounded-full bg-muted">
              <svg
                className="h-16 w-16 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-foreground">
              {t('Your cart is empty', 'سلة التسوق فارغة')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t("Looks like you haven't added any items yet.", 'يبدو أنك لم تضف أي منتجات بعد.')}
            </p>
            <Link href={storeUrl('/products')}>
              <Button className="mt-8 gap-2 rounded-xl shadow-lg shadow-primary/25" size="lg">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
                {t('Start Shopping', 'ابدأ التسوق')}
              </Button>
            </Link>

            {/* Browse Products */}
            <div className="mt-12">
              <Link
                href={storeUrl('/products')}
                className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 19l-7-7m0 0l7-7m-7 7h18"
                  />
                </svg>
                {t('Browse all products', 'تصفح جميع المنتجات')}
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-8 lg:grid lg:grid-cols-12 lg:gap-8">
            {/* Cart Items */}
            <div className="lg:col-span-8">
              <div className="space-y-4">
                {cartItems.map((item, index) => (
                  <div
                    key={item.id}
                    className="cart-item animate-fade-in"
                    style={{ animationDelay: `${index * 100}ms` }}
                  >
                    {/* Product Image */}
                    <div className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-primary/5 to-primary/10 sm:h-32 sm:w-32">
                      <div className="flex h-full items-center justify-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                          <svg
                            className="h-8 w-8 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      </div>
                    </div>

                    {/* Product Details */}
                    <div className="flex flex-1 flex-col gap-2 sm:gap-0">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          {item.category && (
                            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                              {item.category}
                            </span>
                          )}
                          <h3 className="mt-0.5 font-semibold text-foreground">{item.name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {formatPrice(item.price / 1000)} {t('each', 'للواحد')}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemoveItem(item.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-500"
                          aria-label="Remove item"
                        >
                          <svg
                            className="h-5 w-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>

                      <div className="mt-auto flex items-center justify-between pt-2">
                        {/* Quantity Selector */}
                        <div className="flex items-center rounded-xl border border-border bg-background">
                          <button
                            onClick={() => handleUpdateQuantity(item.id, item.quantity - 1)}
                            className="flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Decrease quantity"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M20 12H4"
                              />
                            </svg>
                          </button>
                          <span className="w-10 text-center text-sm font-semibold text-foreground">
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => handleUpdateQuantity(item.id, item.quantity + 1)}
                            className="flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Increase quantity"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 4v16m8-8H4"
                              />
                            </svg>
                          </button>
                        </div>

                        {/* Item Total */}
                        <p className="text-lg font-bold text-primary">
                          {formatPrice((item.price * item.quantity) / 1000)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Continue Shopping */}
              <div className="mt-8">
                <Link
                  href={storeUrl('/products')}
                  className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 19l-7-7m0 0l7-7m-7 7h18"
                    />
                  </svg>
                  {t('Continue Shopping', 'متابعة التسوق')}
                </Link>
              </div>
            </div>

            {/* Order Summary */}
            <div className="mt-8 lg:col-span-4 lg:mt-0">
              <div className="sticky top-24 space-y-6">
                {/* Summary Card */}
                <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
                  <h2 className="text-lg font-bold text-foreground">
                    {t('Order Summary', 'ملخص الطلب')}
                  </h2>

                  {/* Promo Code */}
                  <div className="mt-6">
                    <label className="text-sm font-medium text-foreground">
                      {t('Promo Code', 'كود الخصم')}
                    </label>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={promoCode}
                        onChange={e => setPromoCode(e.target.value)}
                        placeholder={t('Enter code', 'أدخل الكود')}
                        disabled={promoApplied}
                        className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      <button
                        onClick={applyPromoCode}
                        disabled={promoApplied || !promoCode || isValidating}
                        className="h-10 rounded-lg bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {promoApplied
                          ? t('Applied', 'تم التطبيق')
                          : isValidating
                            ? t('Validating...', 'جاري التحقق...')
                            : t('Apply', 'تطبيق')}
                      </button>
                    </div>
                    {promoApplied && (
                      <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        {promoCode.toUpperCase()} - {promoName} ({formatPrice(discount)} off)
                      </p>
                    )}
                  </div>

                  {/* Price Breakdown */}
                  <div className="mt-6 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {t('Subtotal', 'المجموع الفرعي')} ({cartCount} {t('items', 'منتجات')})
                      </span>
                      <span className="font-medium text-foreground">{formatPrice(subtotal)}</span>
                    </div>
                    {promoApplied && (
                      <div className="flex justify-between text-sm">
                        <span className="text-emerald-600">
                          {t('Discount', 'الخصم')} (
                          {promoType === 'percentage' ? `${promoValue}%` : promoName})
                        </span>
                        <span className="font-medium text-emerald-600">
                          -{formatPrice(discount)}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('Shipping', 'الشحن')}</span>
                      {shipping === 0 ? (
                        <span className="font-medium text-emerald-600">{t('Free', 'مجاني')}</span>
                      ) : (
                        <span className="font-medium text-foreground">{formatPrice(shipping)}</span>
                      )}
                    </div>
                    {shipping === 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t('Free shipping on orders over', 'شحن مجاني للطلبات فوق')}{' '}
                        {formatPrice(freeShippingThreshold / 1000)}
                      </p>
                    )}
                    <div className="border-t border-border pt-3">
                      <div className="flex justify-between">
                        <span className="text-lg font-bold text-foreground">
                          {t('Total', 'الإجمالي')}
                        </span>
                        <span className="text-xl font-bold text-primary">{formatPrice(total)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Checkout Button */}
                  <Link href={storeUrl('/checkout')} className="mt-6 block">
                    <Button
                      className="w-full gap-2 rounded-xl shadow-lg shadow-primary/25"
                      size="lg"
                    >
                      {t('Proceed to Checkout', 'المتابعة للدفع')}
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M14 5l7 7m0 0l-7 7m7-7H3"
                        />
                      </svg>
                    </Button>
                  </Link>

                  {/* Security Badge */}
                  <div className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-muted/50 py-3 text-xs text-muted-foreground">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                    {t('Secure checkout with SSL encryption', 'دفع آمن بتشفير SSL')}
                  </div>
                </div>

                {/* Payment Methods */}
                <div className="rounded-2xl border border-border bg-card p-4">
                  <p className="mb-3 text-center text-xs font-medium text-muted-foreground">
                    {t('We Accept', 'نقبل الدفع عبر')}
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    {['KNET', 'Visa', 'Mastercard', 'Apple Pay'].map(method => (
                      <div
                        key={method}
                        className="flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium text-muted-foreground"
                      >
                        {method}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Help */}
                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                      <svg
                        className="h-5 w-5 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {t('Need Help?', 'تحتاج مساعدة؟')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {store.phone
                          ? `${t('Contact us at', 'تواصل معنا على')} ${store.phone}`
                          : t('Visit our contact page for help', 'قم بزيارة صفحة التواصل للمساعدة')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <Footer />
    </main>
  );
}
