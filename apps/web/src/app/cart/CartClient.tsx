'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MINUS, SignedAmount } from '@/lib/bidi';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import Link from '../../components/StoreLink';
import Image from 'next/image';
import { Button, useToast, CartIcon, VariantText } from '@ebda/ui';
import { ShopChrome } from '../../components';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { useCart } from '../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useFeatures } from '../../contexts/FeatureContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '@/lib/api';
import { CartRecommendations } from '../../components/CartRecommendations';
import {
  PageMark,
  itemNodes,
  pageSectionsAround,
  usePageDocument,
  withPageSettings,
} from '../../builder/render/PageDocument';
import { BundleLine } from '../../components/BundleLine';
import { CartLineUnavailableNotice } from '../../templates/shared/CartLineUnavailable';
import { pageSurfaceStyle } from '@/lib/page-surface';
import {
  couponQuoteBasis,
  couponQuoteCartItems,
  couponQuoteLooseFields,
} from '@/lib/coupon-quote-basis';
import { moqShortfalls, moqCartMessage, cartMaxQty, moqFix } from '@/lib/b2b-moq';
import { productUnavailableCopy } from '@/lib/product-cart-errors';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { useLastListing } from '../../hooks/useLastListing';
import { useNumerals } from '../../hooks/useNumerals';
import { formatTaxRowLabel } from '../../lib/tax-display';
import { resolveColor, checkMinimumOrder, computeOrderAmounts, getLook } from '@ebda/shared';
import { AcceptedPaymentBadges } from '../../components/AcceptedPaymentBadges';
import { CartLineNote } from '../../components/commerce/CartLineNote';
import { GoldRateLine } from '../../components/commerce/GoldRateLine';
import { PriceChangedNotice } from '../../components/commerce/PriceChangedNotice';
import { priceChangedLines } from '@/lib/gold-display';
import { StickyCartTotal } from '../../components/commerce/StickyCartTotal';
import { MinOrderProgress } from '../../components/commerce/MinOrderProgress';
import { cartRemovalToast } from './cart-removal';
import { countText, ITEMS } from '../../lib/plural';
import { CART_CHECKOUT_CTA } from '../../lib/checkout-cta';
import { couponErrorCopy } from '../../lib/coupon-errors';
import { ArrowIcon } from '../../templates/shared/icons';
import { Breadcrumbs } from '../../components/Breadcrumbs';

export default function CartClient() {
  const {
    items: cartItems,
    bundles: cartBundles,
    updateQuantity: updateCartQuantity,
    removeItem: removeCartItem,
    addItem,
    removeBundle: removeCartBundle,
    itemCount,
    total: cartTotal,
    isReady: cartIsReady,
    priceChanged,
    acknowledgePrices,
  } = useCart();
  const [acknowledging, setAcknowledging] = useState(false);
  const { store, layout: liveLayout } = useStore();
  // The cart page's section document (Ruling VE-3): which sections go around the cart itself.
  const pageDoc = usePageDocument('cart');
  // In the editor canvas the page's own settings come from the draft document, otherwise the live layout.
  const layout = withPageSettings(pageDoc, liveLayout);
  const storeUrl = useStoreUrl();
  const { isEnabled } = useFeatures();
  // The basis a COUPON is quoted against: loose items only, never the
  // bundle-inclusive `cartTotal`. `OrderService.create` evaluates a coupon
  // against `cart.items` alone (Ruling B1 — a coupon never discounts an
  // already-discounted box), so quoting against a bundle-inclusive total
  // promised a discount the order would never receive. Identical to
  // `cartTotal` for a cart with no bundle.
  const couponBasis = useMemo(() => couponQuoteBasis(cartItems), [cartItems]);
  // #1766: lines whose product the merchant deleted — listed (so they can be
  // removed), marked, and already excluded from `cartTotal` by CartContext.
  const unavailableItems = useMemo(() => cartItems.filter(i => i.unavailable), [cartItems]);
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
  const lang = language === 'ar' ? 'ar' : 'en';
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
  // Default to 0 piastres. A merchant who hasn't set up shipping zones yet
  // shouldn't have a phantom 2.5 EGP fee shown to customers — the
  // backend's calculateShipping returns 0 when no zones exist, but the
  // cart used to show 2.5 EGP on its own UI breakdown until the
  // checkout step corrected it. Same for the free-shipping threshold:
  // 0 means "no threshold configured" so the gate just resolves to
  // free.
  const [shippingFee, setShippingFee] = useState(0);
  const [freeShippingThreshold, setFreeShippingThreshold] = useState(0);
  const [shippingLoaded, setShippingLoaded] = useState(false);
  const { info, success, error: errorToast, addToast } = useToast();

  // Cart mutations optimistically update, reconcile via refetch, then re-throw
  // on API failure. Without this catch the user saw a "removed"/"updated"
  // success toast while the item silently reappeared on reconcile — the exact
  // silent/misleading-failure trap. Surface a specific error instead.
  const cartErrorToast = () =>
    errorToast(
      t('Unable to update cart', 'معرفناش نحدّث السلة'),
      t('Please check your connection and try again.', 'اتأكد من اتصالك وجرّب تاني.')
    );

  const handleUpdateQuantity = async (itemId: string, newQuantity: number) => {
    const item = cartItems.find(i => i.id === itemId);
    if (newQuantity < 1) {
      try {
        await removeCartItem(itemId);
        if (item) addToast(cartRemovalToast(item, { isRtl: language === 'ar', t, addItem }));
      } catch {
        cartErrorToast();
      }
    } else if (newQuantity > (item ? cartMaxQty(item) : 10)) {
      info(
        t('Limit reached', 'وصلت للحد'),
        t('Maximum 10 items per product', 'تقدر تطلب لحد 10 قطع من كل منتج')
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
      if (item) addToast(cartRemovalToast(item, { isRtl: language === 'ar', t, addItem }));
    } catch {
      cartErrorToast();
    }
  };

  const handleRemoveBundle = async (cartBundleId: string, name: string) => {
    try {
      await removeCartBundle(cartBundleId);
      success(
        t('Item removed', 'اتشال'),
        t(`${name} has been removed from your cart`, `شيلنا ${name} من السلة`)
      );
    } catch {
      cartErrorToast();
    }
  };

  const applyPromoCode = useCallback(async () => {
    if (isValidating) return;
    if (!promoCode.trim()) {
      // Y-08: Apply is never dead; an empty tap puts the cursor in the (visible) code field.
      const field = [
        ...document.querySelectorAll<HTMLInputElement>('#cart-promo-code, #cart-promo-code-t'),
      ].find(el => el.offsetParent !== null);
      field?.focus();
      return;
    }
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
        // The loose lines themselves, so the route evaluates the coupon's
        // targeting now rather than accepting a code checkout will refuse.
        cartItems: couponQuoteCartItems(cartItems),
        // A free-shipping code is judged on the whole loose cart (Ruling B2B-M2).
        ...couponQuoteLooseFields(cartItems),
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
          t('Promo applied', 'الخصم اتطبّق'),
          t(
            `${result.data.coupon.name} discount has been applied`,
            `اتطبّق خصم ${result.data.coupon.name}`
          )
        );
      } else {
        // a11y re-audit P1-N1: copy from the error code, in the page language.
        const message = couponErrorCopy(result.error?.code, t);
        info(t('Invalid code', 'كود غير صالح'), message);
      }
    } catch {
      errorToast(
        t('Error', 'خطأ'),
        t(
          'Failed to validate promo code. Please try again.',
          'معرفناش نتأكد من كود الخصم. جرّب تاني.'
        )
      );
    } finally {
      setIsValidating(false);
    }
  }, [promoCode, isValidating, store.id, couponBasis, cartItems, success, info, errorToast, t]);

  // Re-apply a previously validated promo code once the cart has hydrated.
  // The server is still the source of truth for the discount amount; if the
  // stored code is no longer valid we silently drop it.
  const autoAppliedRef = useRef(false);
  // Taste re-audit P2-3: the sticky total waits until the summary checkout button leaves view.
  const summaryRef = useRef<HTMLDivElement>(null);
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
          cartItems: couponQuoteCartItems(cartItems),
          // A free-shipping code is judged on the whole loose cart (Ruling B2B-M2).
          ...couponQuoteLooseFields(cartItems),
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
  }, [cartIsReady, cartTotal, couponBasis, cartItems, store.id]);

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

  // All amounts are in piastres (1 EGP = 100 piastres) so they can be passed directly to formatPrice
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
  // VAT — same formula the API charges at order creation (computeOrderTax,
  // ruling M3-6 in docs/RULINGS.md): the taxable base is subtotal net of
  // discount plus shipping (MONEYB-2). `taxRatePercent` is already zeroed by the API for a disabled
  // store, so `tax = 0` and the summary renders byte-identically to before.
  // `includedInPrice` selects the same extraction branch order creation
  // uses, and that amount is informational only — NOT added to `total`.
  const taxRatePercent = store.taxRatePercent ?? 0;
  const taxIncludedInPrice = !!store.taxIncludedInPrice;
  // Shipping is in the VAT base (ruling MONEYB-2) — the order's own formula. On the cart the
  // summary always reads shipping as "Calculated at checkout" (the per-area fee is only known
  // once the shopper picks an area), so the cart's total must NOT already include a zone fee
  // (F1: the summary said "calculated at checkout" while its total and the sticky bar added
  // 50 EGP). Checkout recomputes with the real fee.
  const CART_SHIPPING_PENDING = 0;
  const { tax, total } = computeOrderAmounts({
    subtotal,
    discount,
    shipping: CART_SHIPPING_PENDING,
    ratePercent: taxRatePercent,
    includedInPrice: taxIncludedInPrice,
  });
  // Label for the fallback (non-themed) summary below — the themed
  // `T.OrderSummary` computes its own copy of this via useOrderSummaryBase.
  const taxLabel = formatTaxRowLabel(
    tax,
    taxRatePercent,
    taxIncludedInPrice,
    language === 'ar',
    localize
  );
  const cartCount = itemCount;
  const { components: T } = useTemplateComponents();

  // Per-store, opt-in minimum order value (Store.settings.minimumOrderFils,
  // piastres; 0/unset = no minimum). This is a UX guard only — the API's
  // OrderService.create is the real, hard-blocking check. store.settings is
  // a loose Record — cast the one key we read, same pattern as
  // checkoutDelivery in CheckoutClient.tsx.
  const minimumOrderFils = store?.settings?.minimumOrderFils as number | undefined;
  const minimumOrderCheck = checkMinimumOrder(subtotal, minimumOrderFils);
  const belowMinimumOrder = !minimumOrderCheck.met;
  const minimumOrderMessage = belowMinimumOrder
    ? t(
        `Minimum order is ${formatPrice(minimumOrderFils as number)} — add ${formatPrice(minimumOrderCheck.shortfallFils)} more`,
        `الحد الأدنى للطلب ${formatPrice(minimumOrderFils as number)} — ضيف ${formatPrice(minimumOrderCheck.shortfallFils)} كمان`
      )
    : undefined;
  // #2117: a line whose product was deleted blocks the order server-side
  // (OrderService.create refuses PRODUCT_NO_LONGER_AVAILABLE), so the banner's
  // "remove it to check out" is enforced here rather than left advisory —
  // otherwise the shopper fills the whole checkout form only to be refused.
  const hasUnavailableLines = unavailableItems.length > 0;
  // B2B minimum order quantity: the server flags each line (`belowMoq`); the order would be refused 422 BELOW_MOQ, so the cart
  // says so inline and disables checkout instead of letting the buyer fill the form first.
  const moqShort = moqShortfalls(
    cartItems.map(i => ({
      productId: i.productId,
      name: i.name,
      nameAr: i.nameAr,
      quantity: i.quantity,
      belowMoq: i.belowMoq,
      moqRequired: i.moqRequired,
      unavailable: i.unavailable,
    }))
  );
  const moqMessage = moqCartMessage(moqShort, language === 'ar' ? 'ar' : 'en');
  const checkoutBlocked = belowMinimumOrder || hasUnavailableLines || !!moqMessage;
  // Ruling B4-6: a look with chrome.cartBar shows the minimum as progress, not a one-line notice.
  const minimumProgress = getLook(store?.look)?.chrome?.cartBar === 'total' && belowMinimumOrder;
  const minimumProgressOnly = minimumProgress && !hasUnavailableLines && !moqMessage;
  const checkoutBlockedMessage =
    minimumOrderMessage ??
    (hasUnavailableLines
      ? t(
          'Remove the unavailable items to check out.',
          'شيل المنتجات اللي مش متوفرة عشان تكمّل الطلب.'
        )
      : moqMessage);

  const around = pageSectionsAround(pageDoc, {
    // Under the cart: shown on all screen sizes, only with items in the cart.
    'cart-recommendations':
      isEnabled('upsell_crosssell') && cartItems.length > 0 && store.id && store.id !== 'demo' ? (
        <div className="mt-8">
          <CartRecommendations
            storeId={store.id}
            // Product ids, not cart-line ids (the API looks up relations by product; line ids
            // matched nothing).
            productIds={[...new Set(cartItems.map(i => i.productId))]}
          />
        </div>
      ) : null,
  });

  return (
    <ShopChrome>
      {/* rule (g): sub-headings and item names here read in the body face, not the display face. */}
      <div className="flex-1" style={cartBgStyle} data-transactional>
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" style={cartDensity}>
          {itemNodes(around.before)}
          <PageMark kind="cart">
            {/* Breadcrumb */}
            <Breadcrumbs
              items={[
                { label: t('Home', translations['Home']), href: storeUrl('/') },
                {
                  label: t(
                    'Shopping cart',
                    '\u0633\u0644\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                  ),
                },
              ]}
            />

            {/* STOP-2 P2-2: an empty cart says "your cart is empty" once. The page still has its h1
              (for screen readers); the visible heading is the empty state's own. */}
            <h1
              className={`text-3xl font-bold tracking-tight text-foreground${
                cartItems.length === 0 && cartBundles.length === 0 ? ' sr-only' : ''
              }`}
              style={cartZoneStyle(cartHeadingZone)}
            >
              {t('Shopping cart', '\u0633\u0644\u0629 \u0627\u0644\u062a\u0633\u0648\u0642')}
            </h1>
            {(cartItems.length > 0 || cartBundles.length > 0) && (
              <p className="mt-2 text-muted-foreground" style={cartZoneStyle(cartLabelZone)}>
                {countText(lang, cartCount, ITEMS, localize(cartCount))}{' '}
                {t('in your cart', 'في سلتك')}
              </p>
            )}
            {unavailableItems.length > 0 && (
              <p
                role="alert"
                data-cart-unavailable-banner=""
                className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive-ink"
              >
                {productUnavailableCopy(
                  t,
                  unavailableItems.length,
                  unavailableItems.map(i => (language === 'ar' && i.nameAr ? i.nameAr : i.name))
                )}
              </p>
            )}

            {moqShort.length > 0 && (
              <div
                data-cart-moq-fix=""
                className="mt-4 space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink"
              >
                {moqShort.map(sf => {
                  const fix = moqFix(sf, cartItems);
                  return (
                    <div key={sf.productId} className="flex flex-wrap items-center gap-3">
                      <span className="font-medium">
                        <bdi>{language === 'ar' && sf.nameAr ? sf.nameAr : sf.name}</bdi>:{' '}
                        {t(`minimum order is ${sf.required}`, `الحد الأدنى للطلب ${sf.required}`)}
                      </span>
                      {fix ? (
                        <button
                          type="button"
                          className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-warning/50 px-4 font-medium hover:bg-warning/20"
                          onClick={() => void handleUpdateQuantity(fix.lineId, fix.quantity)}
                        >
                          {t(`Set to ${fix.quantity}`, `اجعلها ${fix.quantity}`)}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {cartItems.length === 0 && cartBundles.length === 0 ? (
              T?.EmptyState ? (
                <div className="mt-6 sm:mt-16">
                  <T.EmptyState
                    title="Your cart is empty"
                    titleAr="سلتك فاضية"
                    description="Looks like you haven't added any items yet."
                    descriptionAr="لسه مضفتش أي منتج."
                    ctaLabel="Start shopping"
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
                    {t('Your cart is empty', 'سلة التسوق فاضية')}
                  </h2>
                  <p className="mt-2 text-muted-foreground">
                    {t("Looks like you haven't added any items yet.", 'شكلك لسه مضفتش أي منتجات.')}
                  </p>
                  <Link href={storeUrl('/products')} className="inline-block">
                    <Button className="mt-8 gap-2 rounded-[var(--radius)]" size="lg">
                      <CartIcon className="h-5 w-5" />
                      {t(
                        'Start shopping',
                        '\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u0633\u0648\u0642'
                      )}
                    </Button>
                  </Link>

                  {/* Browse Products */}
                  <div className="mt-12">
                    <Link
                      href={storeUrl('/products')}
                      className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
                    >
                      <svg
                        className="h-4 w-4 rtl:-scale-x-100"
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
                    {/* Gold lines (B5-17): the moved price is already on the line; this records that the shopper saw it. */}
                    {priceChanged && (
                      <PriceChangedNotice
                        className="mb-4"
                        lines={priceChangedLines(cartItems, language)}
                        busy={acknowledging}
                        onContinue={() => {
                          setAcknowledging(true);
                          void acknowledgePrices().finally(() => setAcknowledging(false));
                        }}
                      />
                    )}
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
                            available={bundle.available}
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
                    {/* Gold lines: today's rate behind each price, once per piece (every theme's table shares it). */}
                    {cartItems.some(i => i.gold) && (
                      <ul
                        className="mb-4 space-y-2 rounded-lg border border-border p-3"
                        data-testid="cart-gold-rates"
                      >
                        {cartItems
                          .filter(i => i.gold)
                          .map(i => (
                            <li key={i.id} className="text-sm">
                              <span className="font-medium">
                                {language === 'ar' && i.nameAr ? i.nameAr : i.name}
                              </span>
                              <GoldRateLine gold={i.gold} />
                            </li>
                          ))}
                      </ul>
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
                          note: item.note,
                          unavailable: item.unavailable,
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
                            <div
                              data-part="cart-thumb"
                              className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-[var(--radius)] bg-gradient-to-br from-primary/5 to-primary/10 sm:h-32 sm:w-32"
                            >
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
                                    className="mt-0.5 text-lg font-bold text-foreground [overflow-wrap:anywhere] sm:text-xl"
                                    data-zone="productName"
                                    style={cartZoneStyle(cartNameZone)}
                                  >
                                    {language === 'ar' && item.nameAr ? item.nameAr : item.name}
                                  </h3>
                                  {(item.variantTitle || item.variantTitleAr) && (
                                    <p className="mt-0.5 text-sm text-muted-foreground">
                                      <VariantText
                                        title={
                                          (language === 'ar' && item.variantTitleAr
                                            ? item.variantTitleAr
                                            : item.variantTitle || item.variantTitleAr) ?? ''
                                        }
                                      />
                                    </p>
                                  )}
                                  <CartLineNote
                                    note={item.note}
                                    className="mt-0.5 text-sm text-muted-foreground"
                                  />
                                  {item.unavailable && <CartLineUnavailableNotice />}
                                  {/* Taste re-audit P2-2: at quantity 1 the line total already says it. */}
                                  {item.quantity > 1 && (
                                    <p
                                      className="mt-1 text-base font-bold text-muted-foreground sm:text-lg"
                                      data-zone="productPrice"
                                      style={cartZoneStyle(cartPriceZone)}
                                    >
                                      {formatPrice(item.price)}{' '}
                                      {t('each', '\u0644\u0644\u0648\u0627\u062d\u062f')}
                                    </p>
                                  )}
                                </div>
                                <button
                                  onClick={() => handleRemoveItem(item.id)}
                                  className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-ink"
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
                                <div className="inline-flex items-center overflow-hidden rounded-md border border-input">
                                  <button
                                    onClick={() => handleUpdateQuantity(item.id, item.quantity - 1)}
                                    disabled={item.unavailable || item.quantity <= 1}
                                    className={`flex h-11 w-11 items-center justify-center transition-colors ${
                                      item.unavailable || item.quantity <= 1
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
                                    disabled={item.unavailable || item.quantity >= 10}
                                    className={`flex h-11 w-11 items-center justify-center transition-colors ${
                                      item.unavailable || item.quantity >= 10
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
                                  {item.unavailable ? (
                                    <s>{formatPrice(item.price * item.quantity)}</s>
                                  ) : (
                                    formatPrice(item.price * item.quantity)
                                  )}
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
                        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
                      >
                        <svg
                          className="h-4 w-4 rtl:-scale-x-100"
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
                          'Continue shopping',
                          '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                        )}
                      </Link>
                    </div>
                  </div>

                  {/* Order Summary */}
                  <div className="mt-8 lg:col-span-4 lg:mt-0">
                    <div ref={summaryRef} className="sticky top-24 space-y-6">
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
                          tax={tax}
                          taxRatePercent={taxRatePercent}
                          taxIncludedInPrice={taxIncludedInPrice}
                          total={total}
                          currency={store.currency}
                          isRtl={language === 'ar'}
                          ctaLabel={CART_CHECKOUT_CTA.en}
                          ctaLabelAr={CART_CHECKOUT_CTA.ar}
                          ctaHref={storeUrl('/checkout')}
                          ctaDisabled={checkoutBlocked}
                          ctaBlockedMessage={checkoutBlockedMessage}
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
                                {t('Coupon code', 'كود الخصم')}
                              </label>
                              <div className="mt-2 flex gap-2">
                                <input
                                  id="cart-promo-code-t"
                                  spellCheck={false}
                                  autoCapitalize="characters"
                                  autoCorrect="off"
                                  enterKeyHint="done"
                                  type="text"
                                  autoComplete="off"
                                  value={promoCode}
                                  onChange={e => setPromoCode(e.target.value)}
                                  placeholder={t('Enter code', 'أدخل الكود')}
                                  disabled={promoApplied}
                                  className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={applyPromoCode}
                                  disabled={promoApplied || isValidating}
                                >
                                  {promoApplied
                                    ? t('Applied', 'اتطبّق')
                                    : isValidating
                                      ? '…'
                                      : t('Apply', 'تطبيق')}
                                </Button>
                              </div>
                              {promoApplied && (
                                <p
                                  role="status"
                                  className="mt-2 flex items-center gap-1 text-xs text-success-ink"
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
                          <div className="rounded-[var(--radius)] border border-border bg-card p-6 shadow-sm">
                            <h2
                              className="text-lg font-bold text-foreground"
                              style={{
                                ...cartZoneStyle(cartHeadingZone),
                                ...summaryLabelStyle,
                              }}
                            >
                              {t(
                                'Order summary',
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
                                    'Coupon code',
                                    '\u0643\u0648\u062f \u0627\u0644\u062e\u0635\u0645'
                                  )}
                                </label>
                                <div className="mt-2 flex gap-2">
                                  <input
                                    id="cart-promo-code"
                                    spellCheck={false}
                                    autoCapitalize="characters"
                                    autoCorrect="off"
                                    enterKeyHint="done"
                                    type="text"
                                    autoComplete="off"
                                    value={promoCode}
                                    onChange={e => setPromoCode(e.target.value)}
                                    placeholder={t(
                                      'Enter code',
                                      '\u0623\u062f\u062e\u0644 \u0627\u0644\u0643\u0648\u062f'
                                    )}
                                    disabled={promoApplied}
                                    className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:text-sm"
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={applyPromoCode}
                                    disabled={promoApplied || isValidating}
                                  >
                                    {promoApplied
                                      ? t('Applied', 'اتطبّق')
                                      : isValidating
                                        ? t('Validating...', 'بنتأكد...')
                                        : t('Apply', '\u062a\u0637\u0628\u064a\u0642')}
                                  </Button>
                                </div>
                                {promoApplied && (
                                  <p
                                    role="status"
                                    className="mt-2 flex items-center gap-1 text-xs text-success-ink"
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
                                  ({countText(lang, cartCount, ITEMS, localize(cartCount))})
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
                                  <span className="text-success-ink">
                                    {t('Discount', 'الخصم')} (
                                    {promoType === 'percentage' ? `${promoValue}%` : promoName})
                                  </span>
                                  <span className="font-medium text-success-ink">
                                    <SignedAmount sign={MINUS} value={formatPrice(discount)} />
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
                                  {t('Shipping', 'الشحن')}
                                </span>
                                {/* Shipping is resolved at checkout (per delivery
                                  area), not on the cart — show a neutral
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
                              {tax > 0 && taxLabel && !taxIncludedInPrice && (
                                <div className="flex justify-between text-sm">
                                  <span
                                    className={`${summaryFontWeight} text-muted-foreground`}
                                    style={{
                                      ...cartZoneStyle(cartLabelZone),
                                      ...summaryLabelStyle,
                                    }}
                                  >
                                    {taxLabel}
                                  </span>
                                  <span
                                    className="font-bold text-foreground"
                                    style={cartZoneStyle(cartPriceZone)}
                                  >
                                    {formatPrice(tax)}
                                  </span>
                                </div>
                              )}
                              <div className="border-t border-border pt-3">
                                <div className="flex justify-between" data-cart-total="">
                                  <span
                                    className={`text-lg ${summaryFontWeight} text-foreground`}
                                    style={{
                                      ...cartZoneStyle(cartHeadingZone),
                                      ...summaryTotalStyle,
                                    }}
                                  >
                                    {t('Total', 'الإجمالي')}
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
                              {/* Tax already inside the listed price is
                                informational only — a muted caption below
                                Total, never a row in the summed amount
                                column (scoped-audit follow-up: an inclusive
                                amount printed there implied it was added
                                twice). */}
                              {tax > 0 && taxLabel && taxIncludedInPrice && (
                                <p className="text-xs text-muted-foreground">
                                  {taxLabel} {'\u2014'} {formatPrice(tax)}
                                </p>
                              )}
                            </div>

                            {/* Below-minimum progress (Ruling B4-6): a look with chrome.cartBar says what
                              is left as a sentence plus a bar instead of the one-line notice. */}
                            {minimumProgress && (
                              <MinOrderProgress
                                subtotalFils={subtotal}
                                minimumOrderFils={minimumOrderFils}
                                className="mt-4"
                              />
                            )}
                            {/* Below-minimum notice */}
                            {checkoutBlocked && checkoutBlockedMessage && !minimumProgressOnly && (
                              <p className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning-ink">
                                {checkoutBlockedMessage}
                              </p>
                            )}

                            {/* Checkout Button */}
                            {checkoutBlocked ? (
                              <Button
                                type="button"
                                disabled
                                className="mt-6 w-full gap-2 rounded-[var(--radius)]"
                                size="lg"
                              >
                                {t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}
                              </Button>
                            ) : (
                              <Link
                                href={storeUrl('/checkout')}
                                data-cta="button"
                                className="mt-6 block"
                              >
                                <Button className="w-full gap-2 rounded-[var(--radius)]" size="lg">
                                  {t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}
                                  <ArrowIcon className="h-5 w-5" isRtl={language === 'ar'} />
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

                      <AcceptedPaymentBadges />

                      {/* IA-04 (W4): one quiet help line, not a card with an icon tile. */}
                      <p data-testid="cart-help-line" className="text-sm text-muted-foreground">
                        <Link
                          href={storeUrl('/contact')}
                          className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground"
                        >
                          {store.phone
                            ? `${t('Questions? Call', 'عندك سؤال؟ كلّمنا على')} ${store.phone}`
                            : t('Questions? Contact the store', 'عندك سؤال؟ كلّم المتجر')}
                        </Link>
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </PageMark>
          {itemNodes(around.after)}
        </div>
      </div>
      {/* Phone sticky total: same checkoutBlocked rule + message as the summary CTA, and the
          summary's own Total row (label, value AND money format: every summary prints the ONE
          storefront format, "2,980 ج.م" / "EGP 2,980", B1-28). That total is net of the promo discount
          and carries no zone fee while shipping reads "calculated at checkout", so the bar never
          quotes the pre-discount subtotal. */}
      <StickyCartTotal
        totalLabel={t('Total', 'الإجمالي')}
        total={formatPrice(total)}
        itemCount={cartCount}
        itemCountLabel={countText(lang, cartCount, ITEMS, localize(cartCount))}
        href={storeUrl('/checkout')}
        label={t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}
        disabled={checkoutBlocked}
        blockedMessage={checkoutBlockedMessage}
        anchorRef={summaryRef}
      />
    </ShopChrome>
  );
}
