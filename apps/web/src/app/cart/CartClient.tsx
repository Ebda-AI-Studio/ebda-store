'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import Link from 'next/link';
import Image from 'next/image';
import { Button, useToast, CartIcon } from '@force/ui';
import { ShopChrome } from '../../components';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { useCart } from '../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useFeatures } from '../../contexts/FeatureContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '@/lib/api';
import { CartRecommendations } from '../../components/CartRecommendations';
import { BundleLine } from '../../components/BundleLine';
import { pageSurfaceStyle } from '@/lib/page-surface';
import { couponQuoteBasis } from '@/lib/coupon-quote-basis';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { useLastListing } from '../../hooks/useLastListing';
import { useNumerals } from '../../hooks/useNumerals';
import { resolveColor, checkMinimumOrder } from '@force/shared';

export default function CartClient() {
  const {
    items: cartItems,
    bundles: cartBundles,
    updateQuantity: updateCartQuantity,
    removeItem: removeCartItem,
    removeBundle: removeCartBundle,
    itemCount,
    total: cartTotal,
    isReady: cartIsReady,
  } = useCart();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const { isEnabled } = useFeatures();
  // The basis a COUPON is quoted against: loose items only, never the
  // bundle-inclusive `cartTotal`. `OrderService.create` evaluates a coupon
  // against `cart.items` alone (Ruling B1 — a coupon never discounts an
  // already-discounted box), so quoting against a bundle-inclusive total
  // promised a discount the order would never receive. Identical to
  // `cartTotal` for a cart with no bundle.
  const couponBasis = useMemo(() => couponQuoteBasis(cartItems), [cartItems]);
  // Standalone Cart-page typography (page-builder → Cart page). Resolved to
  // inline styles below so they beat the cart's Tailwind size classes.
  //   heading     → page title + "Order summary" heading
  //   subtitle    → secondary labels (items count, subtotal/shipping/total rows)
  //   productName → line-item names
  //   productPrice→ every monetary value (item price/total, subtotal, total)
  const cartHeadingZone = resolveSectionZone(
    layout?.cartPage?.typography?.heading,
    undefined,
    store.theme
  );
  const cartLabelZone = resolveSectionZone(
    layout?.cartPage?.typography?.subtitle,
    undefined,
    store.theme
  );
  const cartNameZone = resolveSectionZone(
    layout?.cartPage?.typography?.productName,
    undefined,
    store.theme
  );
  const cartPriceZone = resolveSectionZone(
    layout?.cartPage?.typography?.productPrice,
    undefined,
    store.theme
  );
  const cartCtaZone = resolveSectionZone(
    layout?.cartPage?.typography?.productCta,
    undefined,
    store.theme
  );
  const cartBgStyle = pageSurfaceStyle(
    layout?.cartPage?.bgColor,
    store.theme,
    layout?.cartPage?.colorScheme
  );
  const cartScale = pageTextScale(layout?.cartPage?.textScale);
  const cartDensity = pageDensityStyle(layout?.cartPage?.density);
  // Scale-aware cart zone → inline style (closes over the page text dial). Inline
  // wins over the theme cart components' Tailwind size classes.
  const cartZoneStyle = (z?: Parameters<typeof zoneStyle>[0]) => zoneStyle(z, cartScale);
  // Bag of inline styles handed to the theme CartTable / OrderSummary so the
  // merchant's Cart-page typography reaches the elements the THEME renders
  // (the fallback markup below applies them directly).
  const cartTypography = {
    heading: cartZoneStyle(cartHeadingZone),
    label: cartZoneStyle(cartLabelZone),
    name: cartZoneStyle(cartNameZone),
    price: cartZoneStyle(cartPriceZone),
    cta: cartZoneStyle(cartCtaZone),
  };
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();
  const continuShoppingHref = useLastListing();

  // ── Summary-label color + bold (StoreTheme → per-store) ─────────────────
  // Defaults: label color → token:foreground (unchanged look), bold → true
  // (matches the existing `font-bold` classes on summary rows).
  const summaryLabelColorResolved = store.theme?.summaryLabelColor
    ? (resolveColor(store.theme.summaryLabelColor, store.theme) ?? undefined)
    : undefined;
  const summaryTotalColorResolved = store.theme?.summaryTotalColor
    ? (resolveColor(store.theme.summaryTotalColor, store.theme) ?? undefined)
    : undefined;
  // summaryLabelBold defaults to true (current look is bold); merchant sets
  // false to switch to regular weight.
  const summaryLabelBold = store.theme?.summaryLabelBold !== false;
  const summaryLabelStyle = summaryLabelColorResolved
    ? { color: summaryLabelColorResolved }
    : undefined;
  const summaryTotalStyle = summaryTotalColorResolved
    ? { color: summaryTotalColorResolved }
    : undefined;
  const summaryFontWeight = summaryLabelBold ? 'font-bold' : 'font-normal';
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoName, setPromoName] = useState('');
  const [promoType, setPromoType] = useState('');
  const [promoValue, setPromoValue] = useState(0);
  const [isValidating, setIsValidating] = useState(false);
  // Default to 0 fils. A merchant who hasn't set up shipping zones yet
  // shouldn't have a phantom 2.5 KWD fee shown to customers — the
  // backend's calculateShipping returns 0 when no zones exist, but the
  // cart used to show 2.5 KWD on its own UI breakdown until the
  // checkout step corrected it. Same for the free-shipping threshold:
  // 0 means "no threshold configured" so the gate just resolves to
  // free.
  const [shippingFee, setShippingFee] = useState(0);
  const [freeShippingThreshold, setFreeShippingThreshold] = useState(0);
  const [shippingLoaded, setShippingLoaded] = useState(false);
  const { info, success, error: errorToast } = useToast();

  // Cart mutations optimistically update, reconcile via refetch, then re-throw
  // on API failure. Without this catch the user saw a "removed"/"updated"
  // success toast while the item silently reappeared on reconcile — the exact
  // silent/misleading-failure trap. Surface a specific error instead.
  const cartErrorToast = () =>
    errorToast(
      t('Unable to update cart', 'تعذّر تحديث السلة'),
      t('Please check your connection and try again.', 'يرجى التحقق من اتصالك والمحاولة مرة أخرى.')
    );

  const handleUpdateQuantity = async (itemId: string, newQuantity: number) => {
    const item = cartItems.find(i => i.id === itemId);
    if (newQuantity < 1) {
      try {
        await removeCartItem(itemId);
        if (item) {
          info(
            t('Item removed', 'تمت الإزالة'),
            t(`${item.name} removed from cart`, `تمت إزالة ${item.name} من السلة`)
          );
        }
      } catch {
        cartErrorToast();
      }
    } else if (newQuantity > 10) {
      info(
        t('Limit reached', 'تم الوصول للحد'),
        t('Maximum 10 items per product', 'الحد الأقصى 10 قطع لكل منتج')
      );
    } else {
      try {
        await updateCartQuantity(itemId, newQuantity);
      } catch {
        cartErrorToast();
      }
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    const item = cartItems.find(i => i.id === itemId);
    try {
      await removeCartItem(itemId);
      if (item) {
        success(
          t('Item removed', 'تمت الإزالة'),
          t(`${item.name} has been removed from your cart`, `تمت إزالة ${item.name} من سلة التسوق`)
        );
      }
    } catch {
      cartErrorToast();
    }
  };

  const handleRemoveBundle = async (cartBundleId: string, name: string) => {
    try {
      await removeCartBundle(cartBundleId);
      success(
        t('Item removed', 'تمت الإزالة'),
        t(`${name} has been removed from your cart`, `تمت إزالة ${name} من سلة التسوق`)
      );
    } catch {
      cartErrorToast();
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
        // `couponBasis`, NOT `cartTotal` — the server applies a coupon to
        // loose items only (see its definition above).
        orderTotal: couponBasis,
      });
      if (result.success && result.data) {
        setPromoApplied(true);
        setPromoDiscount(result.data.discount);
        setPromoName(result.data.coupon.name);
        setPromoType(result.data.coupon.type);
        setPromoValue(result.data.coupon.value);
        // Persist so /checkout can pick it up and the server applies the
        // discount to the order (not just the UI). Keyed by store to avoid
        // leaking across tenants on shared devices.
        if (store.id && typeof window !== 'undefined') {
          try {
            window.sessionStorage.setItem(`force-promo-${store.id}`, result.data.coupon.code);
          } catch {
            // Quota exceeded or storage disabled -- non-fatal.
          }
        }
        success(
          t('Promo applied', 'تم تطبيق الخصم'),
          t(
            `${result.data.coupon.name} discount has been applied`,
            `تم تطبيق خصم ${result.data.coupon.name}`
          )
        );
      } else {
        const message =
          result.error?.message || t('The promo code is not valid', 'كود الخصم غير صالح');
        info(t('Invalid code', 'كود غير صالح'), message);
      }
    } catch {
      errorToast(
        t('Error', 'خطأ'),
        t(
          'Failed to validate promo code. Please try again.',
          'فشل التحقق من كود الخصم. يرجى المحاولة مرة أخرى.'
        )
      );
    } finally {
      setIsValidating(false);
    }
  }, [promoCode, isValidating, store.id, couponBasis, success, info, errorToast, t]);

  // Re-apply a previously validated promo code once the cart has hydrated.
  // The server is still the source of truth for the discount amount; if the
  // stored code is no longer valid we silently drop it.
  const autoAppliedRef = useRef(false);
  useEffect(() => {
    if (autoAppliedRef.current) return;
    if (!cartIsReady || !store.id || cartTotal === 0) return;
    if (typeof window === 'undefined') return;
    const stored = window.sessionStorage.getItem(`force-promo-${store.id}`);
    if (!stored) return;
    autoAppliedRef.current = true;
    (async () => {
      try {
        const result = await api.post<{
          coupon: { id: string; code: string; name: string; type: string; value: number };
          discount: number;
        }>(`/stores/public/${store.id}/coupons/validate`, {
          code: stored,
          // Same loose-items-only basis as the manual apply above.
          orderTotal: couponBasis,
        });
        if (result.success && result.data) {
          setPromoCode(result.data.coupon.code);
          setPromoApplied(true);
          setPromoDiscount(result.data.discount);
          setPromoName(result.data.coupon.name);
          setPromoType(result.data.coupon.type);
          setPromoValue(result.data.coupon.value);
        } else {
          window.sessionStorage.removeItem(`force-promo-${store.id}`);
        }
      } catch {
        // Silent -- user can re-enter the code manually.
      }
    })();
  }, [cartIsReady, cartTotal, couponBasis, store.id]);

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
        // Always flip shippingLoaded once the call resolves, even when
        // the merchant has zero zones configured. Otherwise the
        // breakdown stays in "loading" mode forever and the (0)
        // default never reaches the user.
        if (result.success) {
          if (result.data?.zones?.length) {
            const activeZone =
              result.data.zones.find(z => z.isActive !== false) || result.data.zones[0];
            setShippingFee(activeZone.deliveryFee);
            setFreeShippingThreshold(activeZone.freeShippingThreshold);
          }
          setShippingLoaded(true);
        }
      } catch {
        // Network error — leave shippingLoaded false so we don't lock
        // in a 0 fee that might be wrong; user can retry from checkout.
      }
    }
    if (store.id) {
      fetchShipping();
    }
  }, [store.id]);

  // All amounts are in fils (1 KWD = 1000 fils) so they can be passed directly to formatPrice
  const subtotal = cartTotal;
  const discount = promoApplied ? promoDiscount : 0;
  // shippingLoaded guards against showing a phantom fee while the zones
  // fetch is in flight. Once loaded, `freeShippingThreshold === 0` is
  // treated as "no threshold set" and shipping just resolves to the
  // configured fee (which is also 0 when no zones exist).
  const shipping = shippingLoaded
    ? freeShippingThreshold > 0 && cartTotal >= freeShippingThreshold
      ? 0
      : shippingFee
    : 0;
  const total = subtotal - discount + shipping;
  const cartCount = itemCount;
  const { components: T } = useTemplateComponents();

  // Per-store, opt-in minimum order value (Store.settings.minimumOrderFils,
  // fils; 0/unset = no minimum). This is a UX guard only — the API's
  // OrderService.create is the real, hard-blocking check. store.settings is
  // a loose Record — cast the one key we read, same pattern as
  // checkoutDelivery in CheckoutClient.tsx.
  const minimumOrderFils = store?.settings?.minimumOrderFils as number | undefined;
  const minimumOrderCheck = checkMinimumOrder(subtotal, minimumOrderFils);
  const belowMinimumOrder = !minimumOrderCheck.met;
  const minimumOrderMessage = belowMinimumOrder
    ? t(
        `Minimum order is ${formatPrice(minimumOrderFils as number)} — add ${formatPrice(minimumOrderCheck.shortfallFils)} more`,
        `الحد الأدنى للطلب ${formatPrice(minimumOrderFils as number)} — أضف ${formatPrice(minimumOrderCheck.shortfallFils)} أخرى`
      )
    : undefined;

  return (
    <ShopChrome>
      <div className="flex-1" style={cartBgStyle}>
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" style={cartDensity}>
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
            <span className="text-foreground">
              {t('Shopping Cart', '\u0633\u0644\u0629 \u0627\u0644\u062a\u0633\u0648\u0642')}
            </span>
          </nav>

          <h1
            className="text-3xl font-bold tracking-tight text-foreground"
            style={cartZoneStyle(cartHeadingZone)}
          >
            {t('Shopping Cart', '\u0633\u0644\u0629 \u0627\u0644\u062a\u0633\u0648\u0642')}
          </h1>
          {(cartItems.length > 0 || cartBundles.length > 0) && (
            <p className="mt-2 text-muted-foreground" style={cartZoneStyle(cartLabelZone)}>
              {cartCount} {t('items', '\u0645\u0646\u062a\u062c\u0627\u062a')}{' '}
              {t('in your cart', '\u0641\u064a \u0633\u0644\u062a\u0643')}
            </p>
          )}

          {cartItems.length === 0 && cartBundles.length === 0 ? (
            T?.EmptyState ? (
              <div className="mt-16">
                <T.EmptyState
                  title="Your cart is empty"
                  titleAr="سلة التسوق فارغة"
                  description="Looks like you haven't added any items yet."
                  descriptionAr="يبدو أنك لم تضف أي منتجات بعد."
                  ctaLabel="Start Shopping"
                  ctaLabelAr="ابدأ التسوق"
                  ctaHref={storeUrl('/products')}
                  isRtl={language === 'ar'}
                />
              </div>
            ) : (
              <div className="mt-16 flex flex-col items-center justify-center py-12">
                <div className="mb-6 flex h-32 w-32 items-center justify-center rounded-full bg-muted">
                  <CartIcon className="h-16 w-16 text-muted-foreground" strokeWidth={1} />
                </div>
                <h2 className="text-2xl font-bold text-foreground">
                  {t(
                    'Your cart is empty',
                    '\u0633\u0644\u0629 \u0627\u0644\u062a\u0633\u0648\u0642 \u0641\u0627\u0631\u063a\u0629'
                  )}
                </h2>
                <p className="mt-2 text-muted-foreground">
                  {t(
                    "Looks like you haven't added any items yet.",
                    '\u064a\u0628\u062f\u0648 \u0623\u0646\u0643 \u0644\u0645 \u062a\u0636\u0641 \u0623\u064a \u0645\u0646\u062a\u062c\u0627\u062a \u0628\u0639\u062f.'
                  )}
                </p>
                <Link href={storeUrl('/products')}>
                  <Button className="mt-8 gap-2 rounded-xl shadow-lg shadow-primary/25" size="lg">
                    <CartIcon className="h-5 w-5" />
                    {t(
                      'Start Shopping',
                      '\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u0633\u0648\u0642'
                    )}
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
                    {t(
                      'Browse all products',
                      '\u062a\u0635\u0641\u062d \u062c\u0645\u064a\u0639 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
                    )}
                  </Link>
                </div>
              </div>
            )
          ) : (
            <>
              <div className="mt-8 lg:grid lg:grid-cols-12 lg:gap-8">
                {/* Cart Items */}
                <div className="lg:col-span-8">
                  {/* Bundle boxes — always ONE row per box (never the split
                      per-component allocation), rendered the same regardless
                      of the active theme. `cartBundles` are `CartBundle` rows,
                      each already priced/summed server-side. */}
                  {cartBundles.length > 0 && (
                    <div className="mb-4 space-y-4">
                      {cartBundles.map(bundle => (
                        <BundleLine
                          key={bundle.id}
                          variant="card"
                          name={bundle.name}
                          nameAr={bundle.nameAr}
                          image={bundle.image}
                          quantity={bundle.quantity}
                          total={bundle.total}
                          isRtl={language === 'ar'}
                          onRemove={() =>
                            handleRemoveBundle(
                              bundle.id,
                              language === 'ar' && bundle.nameAr ? bundle.nameAr : bundle.name
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                  {T?.CartTable ? (
                    <T.CartTable
                      items={cartItems.map(item => ({
                        id: item.id,
                        productId: item.productId,
                        name: item.name,
                        nameAr: item.nameAr,
                        slug: item.slug,
                        price: item.price,
                        quantity: item.quantity,
                        image: item.image,
                        variantTitle: item.variantTitle,
                        variantTitleAr: item.variantTitleAr,
                      }))}
                      isRtl={language === 'ar'}
                      currency={store.currency}
                      urlPrefix={storeUrl('')}
                      onUpdateQuantity={handleUpdateQuantity}
                      onRemove={handleRemoveItem}
                      typography={cartTypography}
                    />
                  ) : (
                    <div className="space-y-4">
                      {cartItems.map((item, index) => (
                        <div
                          key={item.id}
                          className="cart-item animate-fade-in"
                          style={{ animationDelay: `${index * 100}ms` }}
                        >
                          {/* Product Image */}
                          <div className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-primary/5 to-primary/10 sm:h-32 sm:w-32">
                            {item.image ? (
                              <Image
                                src={item.image}
                                alt={language === 'ar' && item.nameAr ? item.nameAr : item.name}
                                width={128}
                                height={128}
                                className="h-full w-full object-cover"
                                sizes="(max-width: 640px) 112px, 128px"
                              />
                            ) : (
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
                            )}
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
                                <h3
                                  className="mt-0.5 text-lg font-bold text-foreground sm:text-xl"
                                  data-zone="productName"
                                  style={cartZoneStyle(cartNameZone)}
                                >
                                  {language === 'ar' && item.nameAr ? item.nameAr : item.name}
                                </h3>
                                {(item.variantTitle || item.variantTitleAr) && (
                                  <p className="mt-0.5 text-sm text-muted-foreground">
                                    {language === 'ar' && item.variantTitleAr
                                      ? item.variantTitleAr
                                      : item.variantTitle}
                                  </p>
                                )}
                                <p
                                  className="mt-1 text-base font-bold text-muted-foreground sm:text-lg"
                                  data-zone="productPrice"
                                  style={cartZoneStyle(cartPriceZone)}
                                >
                                  {formatPrice(item.price)}{' '}
                                  {t('each', '\u0644\u0644\u0648\u0627\u062d\u062f')}
                                </p>
                              </div>
                              <button
                                onClick={() => handleRemoveItem(item.id)}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                aria-label={t('Remove item', 'إزالة المنتج')}
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
                              <div className="inline-flex items-center overflow-hidden rounded-md border border-border">
                                <button
                                  onClick={() => handleUpdateQuantity(item.id, item.quantity - 1)}
                                  disabled={item.quantity <= 1}
                                  className={`flex h-11 w-11 items-center justify-center transition-colors ${
                                    item.quantity <= 1
                                      ? 'cursor-not-allowed text-muted-foreground/40'
                                      : 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground'
                                  }`}
                                  aria-label={t('Decrease quantity', 'إنقاص الكمية')}
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
                                <span className="w-10 border-x border-border text-center text-sm font-semibold text-foreground">
                                  {localize(item.quantity)}
                                </span>
                                <button
                                  onClick={() => handleUpdateQuantity(item.id, item.quantity + 1)}
                                  disabled={item.quantity >= 10}
                                  className={`flex h-11 w-11 items-center justify-center transition-colors ${
                                    item.quantity >= 10
                                      ? 'cursor-not-allowed text-muted-foreground/40'
                                      : 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground'
                                  }`}
                                  aria-label={t('Increase quantity', 'زيادة الكمية')}
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
                              <p
                                className="text-base font-bold text-primary sm:text-lg"
                                data-zone="productPrice"
                                style={cartZoneStyle(cartPriceZone)}
                              >
                                {formatPrice(item.price * item.quantity)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Continue Shopping */}
                  <div className="mt-8">
                    <Link
                      href={continuShoppingHref}
                      className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
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
                          d="M10 19l-7-7m0 0l7-7m-7 7h18"
                        />
                      </svg>
                      {t(
                        'Continue Shopping',
                        '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                      )}
                    </Link>
                  </div>
                </div>

                {/* Order Summary */}
                <div className="mt-8 lg:col-span-4 lg:mt-0">
                  <div className="sticky top-24 space-y-6">
                    {T?.OrderSummary ? (
                      <T.OrderSummary
                        subtotal={subtotal}
                        discount={discount}
                        discountLabel={
                          promoApplied
                            ? `${t('Discount', 'الخصم')}${promoType === 'percentage' ? ` (${promoValue}%)` : promoName ? ` — ${promoName}` : ''}`
                            : undefined
                        }
                        shipping={shipping}
                        freeShipping={shipping === 0}
                        // On the cart, shipping isn't resolved yet — the real
                        // per-area fee is only known at checkout once the
                        // customer picks a governorate/area. Show a neutral
                        // "Calculated at checkout" label instead of a
                        // misleading "Free".
                        shippingPending
                        total={total}
                        currency={store.currency}
                        isRtl={language === 'ar'}
                        ctaLabel="Proceed to Checkout"
                        ctaLabelAr="المتابعة للدفع"
                        ctaHref={storeUrl('/checkout')}
                        ctaDisabled={belowMinimumOrder}
                        ctaBlockedMessage={minimumOrderMessage}
                        typography={cartTypography}
                        summaryColors={{
                          labelColor: summaryLabelColorResolved,
                          totalColor: summaryTotalColorResolved,
                          bold: summaryLabelBold,
                        }}
                      >
                        {isEnabled('coupons') && (
                          <div>
                            <label
                              htmlFor="cart-promo-code-t"
                              className="text-sm font-medium text-foreground"
                            >
                              {t('Promo Code', 'كود الخصم')}
                            </label>
                            <div className="mt-2 flex gap-2">
                              <input
                                id="cart-promo-code-t"
                                type="text"
                                autoComplete="off"
                                value={promoCode}
                                onChange={e => setPromoCode(e.target.value)}
                                placeholder={t('Enter code', 'أدخل الكود')}
                                disabled={promoApplied}
                                className="h-11 flex-1 rounded-lg border border-border bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                              />
                              <button
                                onClick={applyPromoCode}
                                disabled={promoApplied || !promoCode || isValidating}
                                className="h-11 rounded-lg bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                              >
                                {promoApplied
                                  ? t('Applied', 'تم')
                                  : isValidating
                                    ? '…'
                                    : t('Apply', 'تطبيق')}
                              </button>
                            </div>
                            {promoApplied && (
                              <p
                                role="status"
                                className="mt-2 flex items-center gap-1 text-xs text-success"
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  aria-hidden
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                                {promoCode.toUpperCase()} — {formatPrice(discount)}{' '}
                                {t('off', 'خصم')}
                              </p>
                            )}
                            {promoApplied && cartBundles.length > 0 && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {t(
                                  'Coupon applies to items outside your bundles — a bundle is already discounted.',
                                  translations[
                                    'Coupon applies to items outside your bundles — a bundle is already discounted.'
                                  ]
                                )}
                              </p>
                            )}
                          </div>
                        )}
                      </T.OrderSummary>
                    ) : (
                      <>
                        {/* Summary Card */}
                        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
                          <h2
                            className="text-lg font-bold text-foreground"
                            style={{
                              ...cartZoneStyle(cartHeadingZone),
                              ...summaryLabelStyle,
                            }}
                          >
                            {t(
                              'Order Summary',
                              '\u0645\u0644\u062e\u0635 \u0627\u0644\u0637\u0644\u0628'
                            )}
                          </h2>

                          {/* Promo Code */}
                          {isEnabled('coupons') && (
                            <div className="mt-6">
                              <label
                                htmlFor="cart-promo-code"
                                className="text-sm font-medium text-foreground"
                              >
                                {t(
                                  'Promo Code',
                                  '\u0643\u0648\u062f \u0627\u0644\u062e\u0635\u0645'
                                )}
                              </label>
                              <div className="mt-2 flex gap-2">
                                <input
                                  id="cart-promo-code"
                                  type="text"
                                  autoComplete="off"
                                  value={promoCode}
                                  onChange={e => setPromoCode(e.target.value)}
                                  placeholder={t(
                                    'Enter code',
                                    '\u0623\u062f\u062e\u0644 \u0627\u0644\u0643\u0648\u062f'
                                  )}
                                  disabled={promoApplied}
                                  className="h-11 flex-1 rounded-lg border border-border bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={applyPromoCode}
                                  disabled={promoApplied || !promoCode || isValidating}
                                  className="h-10 min-w-[88px] rounded-lg bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {promoApplied
                                    ? t(
                                        'Applied',
                                        '\u062a\u0645 \u0627\u0644\u062a\u0637\u0628\u064a\u0642'
                                      )
                                    : isValidating
                                      ? t(
                                          'Validating...',
                                          '\u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0642\u0642...'
                                        )
                                      : t('Apply', '\u062a\u0637\u0628\u064a\u0642')}
                                </button>
                              </div>
                              {promoApplied && (
                                <p
                                  role="status"
                                  className="mt-2 flex items-center gap-1 text-xs text-success"
                                >
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
                                  {promoCode.toUpperCase()} - {promoName} ({formatPrice(discount)}{' '}
                                  off)
                                </p>
                              )}
                              {promoApplied && cartBundles.length > 0 && (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  {t(
                                    'Coupon applies to items outside your bundles — a bundle is already discounted.',
                                    translations[
                                      'Coupon applies to items outside your bundles — a bundle is already discounted.'
                                    ]
                                  )}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Price Breakdown */}
                          <div className="mt-6 space-y-3">
                            <div className="flex justify-between text-sm">
                              <span
                                className={`${summaryFontWeight} text-muted-foreground`}
                                style={{
                                  ...cartZoneStyle(cartLabelZone),
                                  ...summaryLabelStyle,
                                }}
                              >
                                {t(
                                  'Subtotal',
                                  '\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a'
                                )}{' '}
                                ({cartCount} {t('items', '\u0645\u0646\u062a\u062c\u0627\u062a')})
                              </span>
                              <span
                                className="font-bold text-foreground"
                                style={cartZoneStyle(cartPriceZone)}
                              >
                                {formatPrice(subtotal)}
                              </span>
                            </div>
                            {promoApplied && (
                              <div className="flex justify-between text-sm">
                                <span className="text-[hsl(var(--success))]">
                                  {t('Discount', '\u0627\u0644\u062e\u0635\u0645')} (
                                  {promoType === 'percentage' ? `${promoValue}%` : promoName})
                                </span>
                                <span className="font-medium text-[hsl(var(--success))]">
                                  -{formatPrice(discount)}
                                </span>
                              </div>
                            )}
                            <div className="flex justify-between text-sm">
                              <span
                                className={`${summaryFontWeight} text-muted-foreground`}
                                style={{
                                  ...cartZoneStyle(cartLabelZone),
                                  ...summaryLabelStyle,
                                }}
                              >
                                {t('Shipping', '\u0627\u0644\u0634\u062d\u0646')}
                              </span>
                              {/* Shipping is resolved at checkout (per delivery
                                  area), not on the cart \u2014 show a neutral
                                  "Calculated at checkout" label rather than a
                                  premature "Free". */}
                              <span
                                className={`${summaryFontWeight} text-muted-foreground`}
                                style={{
                                  ...cartZoneStyle(cartLabelZone),
                                  ...summaryLabelStyle,
                                }}
                              >
                                {t(
                                  'Calculated at checkout',
                                  '\u064a\u062d\u0633\u0628 \u0639\u0646\u062f \u0627\u0644\u062f\u0641\u0639'
                                )}
                              </span>
                            </div>
                            <div className="border-t border-border pt-3">
                              <div className="flex justify-between">
                                <span
                                  className={`text-lg ${summaryFontWeight} text-foreground`}
                                  style={{
                                    ...cartZoneStyle(cartHeadingZone),
                                    ...summaryTotalStyle,
                                  }}
                                >
                                  {t('Total', '\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a')}
                                </span>
                                <span
                                  className={`text-xl ${summaryFontWeight} text-primary`}
                                  style={{
                                    ...cartZoneStyle(cartPriceZone),
                                    ...summaryTotalStyle,
                                  }}
                                >
                                  {formatPrice(total)}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Below-minimum notice */}
                          {belowMinimumOrder && minimumOrderMessage && (
                            <p className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                              {minimumOrderMessage}
                            </p>
                          )}

                          {/* Checkout Button */}
                          {belowMinimumOrder ? (
                            <Button
                              type="button"
                              disabled
                              className="mt-6 w-full gap-2 rounded-xl shadow-lg shadow-primary/25"
                              size="lg"
                            >
                              {t(
                                'Proceed to Checkout',
                                '\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0644\u0644\u062f\u0641\u0639'
                              )}
                            </Button>
                          ) : (
                            <Link href={storeUrl('/checkout')} className="mt-6 block">
                              <Button
                                className="w-full gap-2 rounded-xl shadow-lg shadow-primary/25"
                                size="lg"
                              >
                                {t(
                                  'Proceed to Checkout',
                                  '\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0644\u0644\u062f\u0641\u0639'
                                )}
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
                          )}

                          {/* Security Badge */}
                          <div className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-muted/50 py-3 text-xs text-muted-foreground">
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
                                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                              />
                            </svg>
                            {t(
                              'Secure checkout with SSL encryption',
                              '\u062f\u0641\u0639 \u0622\u0645\u0646 \u0628\u062a\u0634\u0641\u064a\u0631 SSL'
                            )}
                          </div>
                        </div>
                      </>
                    )}

                    {/* Payment Methods */}
                    <div className="rounded-2xl border border-border bg-card p-4">
                      <p className="mb-3 text-center text-xs font-medium text-muted-foreground">
                        {t(
                          'We Accept',
                          '\u0646\u0642\u0628\u0644 \u0627\u0644\u062f\u0641\u0639 \u0639\u0628\u0631'
                        )}
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-3">
                        {(() => {
                          // Customer-facing payment METHODS (not gateways). The
                          // Kuwait default is correct for most stores; a merchant
                          // can override via settings.acceptedPaymentMethods.
                          const configured = Array.isArray(
                            (store?.settings as Record<string, unknown>)?.acceptedPaymentMethods
                          )
                            ? ((store!.settings as Record<string, unknown>)
                                .acceptedPaymentMethods as string[])
                            : null;
                          const methods =
                            configured && configured.length
                              ? configured
                              : ['KNET', 'Visa', 'Mastercard', 'Apple Pay'];
                          return methods.map(method => (
                            <div
                              key={method}
                              className="flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium text-muted-foreground"
                            >
                              {method}
                            </div>
                          ));
                        })()}
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
                            {t(
                              'Need Help?',
                              '\u062a\u062d\u062a\u0627\u062c \u0645\u0633\u0627\u0639\u062f\u0629\u061f'
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {store.phone
                              ? `${t('Contact us at', '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627 \u0639\u0644\u0649')} ${store.phone}`
                              : t(
                                  'Visit our contact page for help',
                                  '\u0642\u0645 \u0628\u0632\u064a\u0627\u0631\u0629 \u0635\u0641\u062d\u0629 \u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0644\u0644\u0645\u0633\u0627\u0639\u062f\u0629'
                                )}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Cart Recommendations — shown below cart grid on all screen sizes */}
              {isEnabled('upsell_crosssell') &&
                cartItems.length > 0 &&
                store.id &&
                store.id !== 'demo' && (
                  <div className="mt-8">
                    <CartRecommendations storeId={store.id} productIds={cartItems.map(i => i.id)} />
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}
