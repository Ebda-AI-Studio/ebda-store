'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@force/ui';
import { MinimalChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { CheckoutErrorAlert } from './CheckoutErrorAlert';
import { subscriptionRequiredCopy } from './_lib/checkoutErrors';
import { checkoutBundleErrorCopy } from '../../lib/checkout-bundle-errors';
import {
  PRODUCT_NO_LONGER_AVAILABLE,
  pickProductName,
  productUnavailableCopy,
  unavailableProductIds,
} from '../../lib/product-cart-errors';
import { trackInitiateCheckout } from '../../components/MarketingPixels';
import {
  isValidEmail,
  EGYPT_GOVERNORATES,
  findGovernorateByArea,
  resolveColor,
  checkMinimumOrder,
  codFeeForOrder,
  computeOrderAmounts,
  type CodFeeConfig,
  type CheckoutDeliverySettings,
  fromMinor,
  REGION,
  isValidEgyptianMobile,
} from '@force/shared';
import { GovernorateAreaSelect } from './_components/GovernorateAreaSelect';
import { DeliverySection } from './_components/DeliverySection';
import { saveCheckoutInfo, loadCheckoutInfo, clearCheckoutInfo } from './_lib/savedCheckout';
import { handlePaymentCreateResult } from './_lib/paymentResult';
import {
  resolveDeliverySelection,
  getNowMinutesInTimezone,
  formatWindowTime,
  findStillBookableWindow,
  type DeliveryDay,
} from './_lib/deliveryWindows';
import { pageSurfaceStyle } from '@/lib/page-surface';
import { couponQuoteBasis, couponQuoteCartItems } from '@/lib/coupon-quote-basis';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { OrderSummary } from './OrderSummary';
import { estimateLoyaltyRedemption } from './_lib/loyaltyEstimate';
import { repriceAfterCouponRemoval, isShippingSettled } from './_lib/repriceAfterCouponRemoval';
import { useLastListing } from '../../hooks/useLastListing';
import { useWallet } from '../../hooks/useWallet';

// Lazy-load the payment step component (includes PaymentIcons SVGs)
// so it is only fetched when the user advances past the shipping form.
const PaymentStep = dynamic(() => import('./PaymentStep'), {
  loading: () => (
    <div className="animate-pulse space-y-4">
      <div className="h-32 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
    </div>
  ),
});
import type { CheckoutCartItem, CheckoutCartBundle, Coupon, PaymentProvider } from './types';

interface Cart {
  id: string;
  items: CheckoutCartItem[];
  bundles: CheckoutCartBundle[];
  subtotal: number;
  total: number;
}

interface ShippingZone {
  id: string;
  name: string;
  nameAr: string | null;
  areas: string[];
  areasAr: string[];
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

// Area-rate shape returned by the public shipping rates endpoint
interface AreaRate {
  country: string;
  countryAr: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
}

export default function CheckoutClient() {
  const router = useRouter();
  const { store, layout } = useStore();
  // Checkout page design (page-builder → Checkout page).
  const checkoutHeadingZone = resolveSectionZone(
    layout?.checkoutPage?.typography?.heading,
    undefined,
    store?.theme
  );
  const checkoutLabelZone = resolveSectionZone(
    layout?.checkoutPage?.typography?.subtitle,
    undefined,
    store?.theme
  );
  const checkoutPriceZone = resolveSectionZone(
    layout?.checkoutPage?.typography?.productPrice,
    undefined,
    store?.theme
  );
  const checkoutScale = pageTextScale(layout?.checkoutPage?.textScale);
  const checkoutDensity = pageDensityStyle(layout?.checkoutPage?.density);
  const checkoutBgStyle = pageSurfaceStyle(
    layout?.checkoutPage?.bgColor,
    store?.theme,
    layout?.checkoutPage?.colorScheme
  );
  // Inline-style bag handed to the checkout OrderSummary so the merchant's
  // Checkout-page typography reaches its headings / labels / amounts.
  const checkoutTypography = {
    heading: zoneStyle(checkoutHeadingZone, checkoutScale),
    label: zoneStyle(checkoutLabelZone, checkoutScale),
    price: zoneStyle(checkoutPriceZone, checkoutScale),
  };
  // Summary-label color + bold overrides from StoreTheme (new per-store flags).
  const checkoutSummaryColors = store?.theme
    ? {
        labelColor: store.theme.summaryLabelColor
          ? (resolveColor(store.theme.summaryLabelColor, store.theme) ?? undefined)
          : undefined,
        totalColor: store.theme.summaryTotalColor
          ? (resolveColor(store.theme.summaryTotalColor, store.theme) ?? undefined)
          : undefined,
        bold: store.theme.summaryLabelBold !== false,
      }
    : undefined;
  // Optional override for the minimal-chrome label on /checkout. Store
  // owners can rename or clear the "Secure Checkout" text via
  // store.settings.checkoutLabel / .checkoutLabelAr without code changes.
  const checkoutLabelEn =
    (store?.settings?.checkoutLabel as string | undefined) ?? 'Secure Checkout';
  const checkoutLabelAr = (store?.settings?.checkoutLabelAr as string | undefined) ?? 'دفع آمن';
  const storeUrl = useStoreUrl();
  const continueShoppingHref = useLastListing();
  const {
    items: cartContextItems,
    bundles: cartContextBundles,
    total: cartContextTotal,
    isReady: cartIsReady,
    refetchCart,
  } = useCart();
  const { language, t } = useLanguage();
  // Passed down to PaymentStep as the `formatPrice` prop too.
  const formatPrice = useLocalePrice();
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  // True while shipping is being recomputed after a coupon was removed; holds
  // Place Order closed so the charge can never run ahead of the summary.
  const [repricingShipping, setRepricingShipping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Per-store opt-in checkout delivery block (info note + window picker).
  // store.settings is a loose Record — cast the one key we read, same
  // pattern as checkoutLabel/checkoutLabelAr above.
  const checkoutDelivery = store?.settings?.checkoutDelivery as
    | CheckoutDeliverySettings
    | undefined;
  const [selectedDeliveryWindowId, setSelectedDeliveryWindowId] = useState<string | null>(null);
  const [deliveryWindowError, setDeliveryWindowError] = useState<string | null>(null);
  // The day the picker showed when the customer chose (today/tomorrow) — the
  // id alone cannot tell a same-slot midnight crossing from a rollover that
  // would silently move the booking to tomorrow (findStillBookableWindow).
  const [selectedDeliveryDay, setSelectedDeliveryDay] = useState<DeliveryDay | null>(null);
  // "Now" in the store's local timezone, as a TICKING clock (#2047/#2050).
  // It used to be memoized once per mount, so the picker kept offering a
  // window whose cutoff had passed while submit (which re-reads the clock)
  // refused it — an unescapable loop. The picker and submit now read the same
  // clock: a 30s tick (cutoffs are minute-granular), a refresh when the tab
  // becomes visible again, and submit writes its own reading back here.
  // Today/tomorrow + availability derive from this via the pure
  // resolveDeliverySelection helper, which also rolls over to tomorrow once
  // every window's order-by time has passed for today.
  const storeTimezone = store?.timezone || 'Africa/Cairo';
  const [nowMinutes, setNowMinutes] = useState(() => getNowMinutesInTimezone(storeTimezone));
  const deliveryWindowsEnabled = !!checkoutDelivery?.windows?.enabled;
  useEffect(() => {
    const tick = () => setNowMinutes(getNowMinutesInTimezone(storeTimezone));
    tick();
    if (!deliveryWindowsEnabled) return;
    const interval = setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [storeTimezone, deliveryWindowsEnabled]);
  const deliverySelection = useMemo(
    () =>
      checkoutDelivery?.windows?.enabled
        ? resolveDeliverySelection(checkoutDelivery.windows.items, nowMinutes)
        : { day: 'today' as const, windows: [] },
    [checkoutDelivery, nowMinutes]
  );
  const lapsedWindowMessage = t(
    'The time you chose is no longer available — please pick another.',
    'الموعد الذي اخترته لم يعد متاحًا — يرجى اختيار موعد آخر.'
  );
  // A picked window whose cutoff passes while the customer is still on the
  // page is dropped with a SPECIFIC message, and the picker (same clock)
  // already shows it closed — never a generic "please select" next to a
  // window that still looks selectable.
  useEffect(() => {
    if (!selectedDeliveryWindowId) return;
    if (findStillBookableWindow(deliverySelection, selectedDeliveryWindowId, selectedDeliveryDay)) {
      return;
    }
    setSelectedDeliveryWindowId(null);
    setSelectedDeliveryDay(null);
    setDeliveryWindowError(lapsedWindowMessage);
  }, [deliverySelection, selectedDeliveryWindowId, selectedDeliveryDay, lapsedWindowMessage]);

  // Fire InitiateCheckout pixel event once the cart has hydrated from the
  // server and we know it isn't empty. Firing on mount (before hydration)
  // would miss the event because cartContextItems starts empty.
  const pixelFiredRef = useRef(false);
  useEffect(() => {
    if (pixelFiredRef.current) return;
    if (!cartIsReady || (cartContextItems.length === 0 && cartContextBundles.length === 0)) return;
    pixelFiredRef.current = true;
    trackInitiateCheckout({
      contentIds: [
        ...cartContextItems.map(item => item.productId),
        ...cartContextBundles.map(b => b.bundleId),
      ],
      numItems:
        cartContextItems.reduce((sum, item) => sum + item.quantity, 0) +
        cartContextBundles.reduce((sum, b) => sum + b.quantity, 0),
      value: fromMinor(cartContextTotal),
      currency: REGION.currency,
    });
  }, [cartIsReady, cartContextItems, cartContextBundles, cartContextTotal]);

  // CartContext is write-through to /public/cart, so the context is the
  // single source of truth for both display and order creation. Memoized so
  // hooks that depend on it don't re-run on unrelated re-renders.
  //
  // A cart holding ONLY bundles (no loose items) is valid — gating this on
  // `cartContextItems.length` alone made `cart` null for a bundle-only
  // cart, which rendered the "cart is empty" screen and blocked checkout
  // entirely for a customer who bought nothing but a box.
  const cart: Cart | null = useMemo(() => {
    if (cartContextItems.length === 0 && cartContextBundles.length === 0) return null;
    return {
      id: 'cart',
      // #1766: a line whose product was deleted is not in `cartContextTotal`
      // and can never be ordered, so it is not listed in the summary either
      // (the summary's lines must add up to its total). The PRODUCT_NO_LONGER
      // _AVAILABLE refusal below still names it, off `cartContextItems`.
      items: cartContextItems
        .filter(item => !item.unavailable)
        .map(item => ({
          id: item.id,
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
          product: {
            id: item.productId,
            name: item.name,
            // Forward the Arabic name so OrderSummary's productLabel
            // picks it on Arabic locale. The CartContext already loads
            // nameAr off `Product.nameAr`; this map was previously
            // dropping it on the floor, leaving the checkout / payment
            // review pages stuck on the English name even when the rest
            // of the storefront localised correctly.
            nameAr: item.nameAr,
            slug: item.slug,
            images: item.image ? [{ id: '1', url: item.image, alt: item.name }] : [],
          },
        })),
      bundles: cartContextBundles.map(b => ({
        id: b.id,
        bundleId: b.bundleId,
        name: b.name,
        nameAr: b.nameAr,
        image: b.image,
        quantity: b.quantity,
        total: b.total,
        // #1555: was dropped here — CartContext already carries it off
        // GET /public/cart's CartBundleView.available.
        available: b.available,
      })),
      subtotal: cartContextTotal,
      total: cartContextTotal,
    };
  }, [cartContextItems, cartContextBundles, cartContextTotal]);

  // #2116/#2117: lines whose product was deleted are priced OUT of `cart`
  // above (#1766), but they still block the order — OrderService.create
  // refuses PRODUCT_NO_LONGER_AVAILABLE while any remains. So the checkout
  // must SAY so, before the shopper fills the form, instead of silently
  // listing a shorter summary (and, for an all-unavailable cart, instead of
  // claiming the cart is empty — it is not; /cart still shows the lines).
  const unavailableCartItems = cartContextItems.filter(item => item.unavailable);
  const unavailableLinesNotice =
    unavailableCartItems.length > 0
      ? productUnavailableCopy(
          t,
          unavailableCartItems.length,
          unavailableCartItems.map(item => pickProductName(item, language))
        )
      : null;
  // The basis a COUPON is quoted against: loose items only, never the
  // bundle-inclusive `cart.subtotal`. `OrderService.create` evaluates a
  // coupon against `cart.items` alone (Ruling B1 — a coupon never
  // discounts an already-discounted box), so quoting against a subtotal
  // that included bundles promised a discount the server then refused to
  // apply, and the customer was charged more than this page showed.
  // Identical to `cart.subtotal` for a cart with no bundle.
  const couponBasis = useMemo(() => couponQuoteBasis(cartContextItems), [cartContextItems]);
  const [, setShippingZones] = useState<ShippingZone[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<PaymentProvider[]>([]);
  // A FAILED payment-config load must not masquerade as "no payment methods
  // configured" (a transient network error is not a merchant misconfiguration).
  // Track the load failure separately and offer a retry.
  const [paymentConfigError, setPaymentConfigError] = useState(false);
  const [checkoutReloadKey, setCheckoutReloadKey] = useState(0);

  // Area-rate data fetched once on mount from the public endpoint
  const [ratedAreas, setRatedAreas] = useState<Set<string>>(new Set());
  const [ratedGovernorates, setRatedGovernorates] = useState<Set<string>>(new Set());
  const [rateByArea, setRateByArea] = useState<Map<string, AreaRate>>(new Map());
  // Full rates array — passed to GovernorateAreaSelect for custom-area support
  const [allAreaRates, setAllAreaRates] = useState<AreaRate[]>([]);
  const [shippingUnavailable, setShippingUnavailable] = useState(false);
  // Distinguish "shipping fee couldn't be calculated" (transient failure) from
  // "area not covered" (shippingUnavailable) — a silent catch left a stale/zero
  // fee on screen with no signal.
  const [shippingError, setShippingError] = useState(false);
  // Whether the store configured per-area shipping rates at all. When false,
  // the store has no shipping config → legacy free-shipping behavior (cost 0),
  // NOT "unavailable". A `matched:false` result only means "not available"
  // when the store DOES have area rates but this specific area isn't covered.
  const [storeHasAreaRates, setStoreHasAreaRates] = useState(false);

  // Shipping & discount
  const [selectedArea, setSelectedArea] = useState('');
  const [shippingCost, setShippingCost] = useState(0);
  // A shipping quote is in flight — the fee on screen is the PREVIOUS one
  // (another area, or a removed free-shipping coupon's 0) until it lands.
  const [shippingQuotePending, setShippingQuotePending] = useState(false);
  // Only the latest quote may write the fee: an older response landing after
  // a newer one (fast area changes) would otherwise put the wrong area's fee
  // back on screen.
  const shippingQuoteSeqRef = useRef(0);
  const [freeShipping, setFreeShipping] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponError, setCouponError] = useState('');

  // Loyalty redemption (logged-in customers only). `loyalty` holds the
  // customer's balance + the store's redemption settings; `redeemEnabled`
  // toggles whether to apply points to THIS order; `pointsToRedeem` is the
  // number the customer chose. All money math is re-validated server-side at
  // order create — these values are display-only / a request.
  const { isAuthenticated } = useAuth();
  const [loyalty, setLoyalty] = useState<{
    points: number;
    pointsValue: number; // piastres per point
    minRedeemPoints: number;
    maxRedeemPercentage: number;
  } | null>(null);
  const [redeemEnabled, setRedeemEnabled] = useState(false);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  // Customer wallet (store credit, D1). `wallet` is non-null only when the API
  // confirms the wallet for this signed-in customer; the "Use wallet balance"
  // option additionally needs the store's wallet checkout to be available and
  // a positive balance. Opt-in per order (defaults off), and — like loyalty —
  // the amount is display-only: the server spends min(balance, total).
  const { wallet, refresh: refreshWallet } = useWallet();
  const walletSpendable = !!wallet && wallet.checkoutAvailable && wallet.balance > 0;
  const [useWalletBalance, setUseWalletBalance] = useState(false);
  // "Send me offers by SMS" (issue 206): unticked by default, rendered only
  // when the store can actually send promotional SMS (store.smsMarketingOptIn).
  const [smsOptIn, setSmsOptIn] = useState(false);
  const showSmsOptIn = store?.smsMarketingOptIn === true;

  // Payment
  const [selectedProvider, setSelectedProvider] = useState('');
  // COD fee settings from /payments/config — the checkout quotes the fee with
  // the SAME function the order freezes it with (codFeeForOrder, MONEYB-3).
  const [codFeeConfig, setCodFeeConfig] = useState<CodFeeConfig | null>(null);

  // "Save my info" — persists contact + address to localStorage (device-local,
  // store-scoped). Default false. Never stores payment data.
  const [saveInfo, setSaveInfo] = useState(false);

  // Form data — persisted in sessionStorage so a page refresh mid-checkout
  // doesn't wipe what the customer already typed.
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    // Egyptian structured address fields
    governorate: '', // EN canonical (e.g. 'Cairo')
    area: '', // EN canonical (e.g. 'Maadi')
    street: '', // الشارع *
    building: '', // رقم المبنى *
    floor: '', // الدور (optional)
    apartment: '', // الشقة (optional)
    landmark: '', // علامة مميزة (optional)
    notes: '',
    // kept for back-compat with sessionStorage / PaymentStep display
    address: '',
  });

  const checkoutStorageKey = store?.id ? `force-checkout-form-${store.id}` : null;
  const promoStorageKey = store?.id ? `force-promo-${store.id}` : null;

  // Hydrate form from sessionStorage once the store id is known. Also sweep
  // any stale per-tenant keys left over from a previous store so a shared
  // device can't surface one tenant's in-flight form/promo in another.
  useEffect(() => {
    if (!store?.id || typeof window === 'undefined') return;

    // Sweep stale tenant keys.
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (!key) continue;
        const isCheckoutKey = key.startsWith('force-checkout-form-');
        const isPromoKey = key.startsWith('force-promo-');
        if (!isCheckoutKey && !isPromoKey) continue;
        const keyStoreId = isCheckoutKey
          ? key.slice('force-checkout-form-'.length)
          : key.slice('force-promo-'.length);
        if (keyStoreId !== store.id) toRemove.push(key);
      }
      for (const key of toRemove) window.sessionStorage.removeItem(key);
    } catch {
      // Non-fatal.
    }

    if (!checkoutStorageKey) return;
    try {
      const saved = window.sessionStorage.getItem(checkoutStorageKey);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        setFormData(prev => ({ ...prev, ...parsed }));
        if (typeof parsed.area === 'string' && parsed.area) {
          setSelectedArea(parsed.area);
        }
      }
    } catch {
      // Corrupt JSON — drop it and start fresh.
      window.sessionStorage.removeItem(checkoutStorageKey);
    }
  }, [checkoutStorageKey, store?.id]);

  // Persist form to sessionStorage on every change (skip empty default state).
  useEffect(() => {
    if (!checkoutStorageKey || typeof window === 'undefined') return;
    const hasContent = Object.values(formData).some(v => typeof v === 'string' && v.trim() !== '');
    if (!hasContent) return;
    try {
      window.sessionStorage.setItem(checkoutStorageKey, JSON.stringify(formData));
    } catch {
      // Quota exceeded or storage disabled — not fatal.
    }
  }, [formData, checkoutStorageKey]);

  // Phase 6 (Option C): WaTokenHydrator stashes the customer's WhatsApp phone
  // under `ebda.wa-customer-phone` when a customer arrives via the WhatsApp
  // ordering flow. Pre-fill the shipping phone with that value when the form
  // is otherwise blank — never overwrite a value the customer already typed.
  // The marker is removed once consumed so a later session-storage hit can't
  // clobber a deliberate edit on a return visit.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (formData.phone.trim() !== '') return;
    let waPhone: string | null = null;
    try {
      waPhone = window.sessionStorage.getItem('ebda.wa-customer-phone');
    } catch {
      return;
    }
    if (!waPhone) return;
    const normalized = waPhone.trim();
    if (!normalized) return;
    setFormData(prev => (prev.phone.trim() === '' ? { ...prev, phone: normalized } : prev));
    try {
      window.sessionStorage.removeItem('ebda.wa-customer-phone');
    } catch {
      // Non-fatal.
    }
  }, [formData.phone]);

  // On mount: prefill from localStorage ("Save my info" persistence).
  // Runs once when the store id is known. If saved data exists, merge it
  // over the default form state and turn the saveInfo checkbox on.
  useEffect(() => {
    if (!store?.id || typeof window === 'undefined') return;
    const saved = loadCheckoutInfo(store.id);
    if (!saved) return;
    setFormData(prev => ({
      ...prev,
      firstName: saved.firstName || prev.firstName,
      lastName: saved.lastName || prev.lastName,
      phone: saved.phone || prev.phone,
      email: saved.email || prev.email,
      governorate: saved.governorate || prev.governorate,
      area: saved.area || prev.area,
      street: saved.street || prev.street,
      building: saved.building || prev.building,
      floor: saved.floor || prev.floor,
      apartment: saved.apartment || prev.apartment,
      landmark: saved.landmark || prev.landmark,
      notes: saved.notes || prev.notes,
    }));
    if (saved.area) setSelectedArea(saved.area);
    setSaveInfo(true);
  }, [store?.id]);

  // Form validation errors
  const [formErrors, setFormErrors] = useState<{
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    governorate?: string;
    area?: string;
    street?: string;
    building?: string;
    address?: string;
  }>({});

  // Checkout error state
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Fetch initial data (shipping zones and payment config)
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setPaymentConfigError(false);
      try {
        // Fetch shipping zones and payment config in parallel
        const [shippingResult, paymentResult] = await Promise.all([
          store?.id
            ? api.get<{ zones: ShippingZone[] }>(`/stores/public/${store.id}/shipping`)
            : Promise.resolve(null),
          api.get<{
            providers: (PaymentProvider | string)[];
            /** Per online provider, the methods the merchant turned on. */
            methods?: Record<string, Array<{ code: string; name: string; nameAr: string }>>;
            defaultProvider?: string;
            cod?: {
              fixedFee: number;
              percentBps?: number;
              displayName: string;
              displayNameAr: string | null;
            };
            instapay?: { displayName: string; displayNameAr: string | null; expiryHours: number };
          }>('/payments/config'),
        ]);

        if (shippingResult?.success && shippingResult.data) {
          setShippingZones(shippingResult.data.zones || []);
        }

        // Fetch per-area rates for the hide-unpriced filter + inline fee display.
        // This is best-effort — if it fails, the full canonical list is shown.
        if (store?.id) {
          try {
            const ratesResult = await api.get<{ rates: AreaRate[] }>(
              `/stores/public/${store.id}/shipping/area-rates`
            );
            if (ratesResult.success && ratesResult.data?.rates?.length) {
              const rates = ratesResult.data.rates;
              const areaSet = new Set(rates.map(r => r.area));
              const govSet = new Set(rates.map(r => r.governorate));
              const byArea = new Map(rates.map(r => [r.area, r]));
              setRatedAreas(areaSet);
              setRatedGovernorates(govSet);
              setRateByArea(byArea);
              setAllAreaRates(rates);
            }
          } catch {
            // Non-fatal — fall back to showing all areas
          }
        }

        if (paymentResult.success && paymentResult.data) {
          // API returns providers as a string[] (e.g. ["paymob"]) — normalize
          // each entry to the {id, name} object the PaymentStep map expects.
          // PaymentStep falls back to DEFAULT_PAYMENT_PROVIDERS for display info.
          //
          // Paymob and Fawry offer several methods the customer chooses between here (card,
          // Meeza, wallet, valU / Pay at Fawry, card): each becomes its own option with the id
          // `<provider>:<method>`. Kashier's hosted page offers its methods itself, so it stays one
          // option.
          const rawProviders = paymentResult.data.providers || [];
          const allProviders: PaymentProvider[] = rawProviders.flatMap(p => {
            if (typeof p !== 'string') return [p];
            const methods = paymentResult.data?.methods?.[p] ?? [];
            if ((p === 'paymob' || p === 'fawry') && methods.length > 0) {
              return methods.map(m => ({
                id: `${p}:${m.code}`,
                name: m.name,
                nameAr: m.nameAr,
                methods: [m.code],
              }));
            }
            return [{ id: p, name: p === 'kashier' ? 'Card / wallet' : p }];
          });

          // Add COD as a provider option if enabled
          if (paymentResult.data.cod) {
            // The whole fee — fixed AND percentage — is quoted in the summary
            // as its own row once COD is chosen (ruling MONEYB-3); the option
            // label only says a fee applies.
            const cod = paymentResult.data.cod;
            setCodFeeConfig({ fixedFee: cod.fixedFee || 0, percentBps: cod.percentBps || 0 });
            const hasFee = (cod.fixedFee || 0) > 0 || (cod.percentBps || 0) > 0;
            const pct = cod.percentBps ? `${Number((cod.percentBps / 100).toFixed(2))}%` : '';
            const fixed = cod.fixedFee ? formatPrice(cod.fixedFee) : '';
            const feeText = hasFee ? ` (+${[fixed, pct].filter(Boolean).join(' + ')})` : '';
            allProviders.push({
              id: 'cod',
              name: `${cod.displayName || 'Cash on Delivery'}${feeText}`,
              nameAr: `${cod.displayNameAr || 'الدفع عند الاستلام'}${feeText}`,
              description: 'Pay when your order is delivered',
              descriptionAr: 'ادفع عند استلام طلبك',
            });
          }

          // InstaPay (manual transfer; the merchant confirms) when the store offers it.
          if (paymentResult.data.instapay) {
            allProviders.push({
              id: 'instapay',
              name: paymentResult.data.instapay.displayName || 'InstaPay',
              nameAr: paymentResult.data.instapay.displayNameAr || 'إنستاباي',
              description: 'Transfer with InstaPay, the store confirms when it arrives',
              descriptionAr: 'حوّل عبر إنستاباي ويؤكد المتجر طلبك عند وصول المبلغ',
            });
          }

          setPaymentProviders(allProviders);
          if (paymentResult.data.defaultProvider) {
            // The default is a provider id; a provider shown as several methods starts on its first.
            const def = paymentResult.data.defaultProvider;
            const first = allProviders.find(o => o.id === def || o.id.startsWith(`${def}:`));
            setSelectedProvider(first?.id ?? def);
          }
        } else {
          // Payment config genuinely failed to load (network/5xx) — surface it
          // as a retryable error rather than "no methods configured".
          setPaymentConfigError(true);
        }
      } catch (error) {
        console.error('Failed to fetch checkout data:', error);
        setPaymentConfigError(true);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [store?.id, checkoutReloadKey]);

  // Calculate shipping when area changes
  //
  // Resolves true only when a quote actually LANDED (#2067): it never throws,
  // so a caller that needs to know whether the fee is real reads this — and
  // the submit gates read `shippingError`/`shippingQuotePending` via
  // isShippingSettled().
  const calculateShipping = useCallback(async (): Promise<boolean> => {
    if (!selectedArea || !store?.id || !cart?.subtotal) return false;

    const seq = ++shippingQuoteSeqRef.current;
    const isLatest = () => seq === shippingQuoteSeqRef.current;
    setShippingUnavailable(false);
    setShippingError(false);
    setShippingQuotePending(true);
    try {
      const result = await api.post<{
        shippingCost: number;
        freeShipping: boolean;
        matched?: boolean;
        storeHasAreaRates?: boolean;
      }>(`/stores/public/${store.id}/shipping/calculate`, {
        area: selectedArea,
        orderTotal: cart.subtotal,
        governorate: formData.governorate,
      });
      if (!isLatest()) return false;
      if (result.success && result.data) {
        const hasAreaRates = result.data.storeHasAreaRates === true;
        setStoreHasAreaRates(hasAreaRates);
        // "Not available for delivery" applies ONLY when the store configured
        // per-area rates but this specific area isn't covered. A store with no
        // shipping config at all (storeHasAreaRates === false) falls back to
        // the resolved cost (typically 0 = free) and must never block checkout.
        if (hasAreaRates && result.data.matched === false) {
          setShippingUnavailable(true);
          setShippingCost(0);
          setFreeShipping(false);
        } else {
          setShippingUnavailable(false);
          setShippingCost(result.data.shippingCost || 0);
          setFreeShipping(result.data.freeShipping || false);
        }
        return true;
      }
      setShippingError(true);
      return false;
    } catch (error) {
      console.error('Failed to calculate shipping:', error);
      if (isLatest()) setShippingError(true);
      return false;
    } finally {
      if (isLatest()) setShippingQuotePending(false);
    }
  }, [selectedArea, store?.id, cart?.subtotal, formData.governorate]);

  useEffect(() => {
    calculateShipping();
  }, [calculateShipping]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'area') {
      setSelectedArea(value);
    }
    // Clear error when user starts typing
    if (formErrors[field as keyof typeof formErrors]) {
      setFormErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  // Handler for GovernorateAreaSelect onChange — updates both governorate and area
  const handleGovernorateAreaChange = (govEn: string, areaEn: string) => {
    setFormData(prev => ({ ...prev, governorate: govEn, area: areaEn }));
    setSelectedArea(areaEn);
    setShippingUnavailable(false);
    // Clear related errors
    setFormErrors(prev => ({ ...prev, governorate: undefined, area: undefined }));
  };

  // Validate form data
  const validateForm = (): boolean => {
    const errors: typeof formErrors = {};

    // Email validation — optional. Only validate format if the customer
    // chose to enter one; empty is allowed and the order proceeds.
    if (formData.email.trim() && !isValidEmail(formData.email)) {
      errors.email = t('Please enter a valid email address', 'يرجى إدخال بريد إلكتروني صحيح');
    }

    // First name validation
    if (!formData.firstName.trim()) {
      errors.firstName = t('First name is required', 'الاسم الأول مطلوب');
    } else if (formData.firstName.trim().length < 2) {
      errors.firstName = t(
        'First name must be at least 2 characters',
        'الاسم الأول يجب أن يكون حرفين على الأقل'
      );
    }

    // Last name validation
    if (!formData.lastName.trim()) {
      errors.lastName = t('Last name is required', 'الاسم الأخير مطلوب');
    } else if (formData.lastName.trim().length < 2) {
      errors.lastName = t(
        'Last name must be at least 2 characters',
        'الاسم الأخير يجب أن يكون حرفين على الأقل'
      );
    }

    // Phone validation (Egypt format)
    if (!formData.phone.trim()) {
      errors.phone = t('Phone number is required', 'رقم الهاتف مطلوب');
    } else {
      // Egyptian mobile: 010/011/012/015 + 8 digits, with or without the
      // trunk 0 / +20 (Eastern Arabic digits accepted). One shared rule.
      if (!isValidEgyptianMobile(formData.phone)) {
        errors.phone = t(
          'Please enter a valid Egyptian mobile number (e.g. 01012345678)',
          'يرجى إدخال رقم موبايل مصري صحيح (مثال: 01012345678)'
        );
      }
    }

    // Governorate + Area validation
    if (!formData.governorate) {
      errors.governorate = t('Please select a governorate', 'يرجى اختيار المحافظة');
    }
    if (!formData.area) {
      errors.area = t('Please select a delivery area', 'يرجى اختيار منطقة التوصيل');
    }

    // Street validation (required)
    if (!formData.street.trim()) {
      errors.street = t('Street is required', 'الشارع مطلوب');
    }

    // Building validation (required)
    if (!formData.building.trim()) {
      errors.building = t('Building number is required', 'رقم المبنى مطلوب');
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Apply coupon. Accepts an optional code override so the auto-apply effect
  // can pass a stored code directly without waiting for couponCode state.
  const applyCouponCode = useCallback(
    async (codeOverride?: string) => {
      const code = (codeOverride ?? couponCode).trim();
      if (!code || !store?.id || !cart) return;

      setCouponError('');
      try {
        const result = await api.post<{ coupon: Coupon; discount: number }>(
          `/stores/public/${store.id}/coupons/validate`,
          // `couponBasis`, NOT `cart.subtotal` — see its definition: the
          // server applies the coupon to loose items only, so quoting
          // against the bundle-inclusive total displayed a discount the
          // order would never receive.
          {
            code,
            orderTotal: couponBasis,
            // The lines + typed identity let the route evaluate targeting the
            // way OrderService.create will, instead of accepting a code the
            // order then refuses.
            cartItems: couponQuoteCartItems(cartContextItems),
            phone: formData.phone.trim() || undefined,
            email: formData.email.trim() || undefined,
          }
        );
        if (result.success && result.data) {
          setCouponCode(result.data.coupon.code);
          setAppliedCoupon(result.data.coupon);
          setCouponDiscount(result.data.discount);
          if (result.data.coupon.type === 'free_shipping') {
            setFreeShipping(true);
            setShippingCost(0);
          }
          // Persist so a refresh or navigation back to /cart keeps the promo.
          if (promoStorageKey && typeof window !== 'undefined') {
            try {
              window.sessionStorage.setItem(promoStorageKey, result.data.coupon.code);
            } catch {
              // Non-fatal.
            }
          }
        } else {
          setCouponError(
            result.error?.code === 'COUPON_NOT_ELIGIBLE'
              ? t(
                  'This coupon does not apply to the items in your cart.',
                  'هذا الكوبون لا ينطبق على المنتجات في سلتك.'
                )
              : result.error?.message || t('Invalid coupon', 'كوبون غير صالح')
          );
          // Stored code is no longer valid -- drop it so we don't auto-apply again.
          if (codeOverride && promoStorageKey && typeof window !== 'undefined') {
            try {
              window.sessionStorage.removeItem(promoStorageKey);
            } catch {
              // Non-fatal.
            }
          }
        }
      } catch {
        setCouponError(t('Failed to apply coupon', 'فشل تطبيق الكوبون'));
      }
    },
    [
      couponCode,
      store?.id,
      cart,
      couponBasis,
      cartContextItems,
      formData.phone,
      formData.email,
      promoStorageKey,
      t,
    ]
  );

  const handleApplyCoupon = () => applyCouponCode();

  // Clear saved checkout info and reset the relevant form fields to blank.
  const handleClearSavedData = () => {
    if (store?.id) clearCheckoutInfo(store.id);
    setSaveInfo(false);
    setFormData(prev => ({
      ...prev,
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      governorate: '',
      area: '',
      street: '',
      building: '',
      floor: '',
      apartment: '',
      landmark: '',
      notes: '',
    }));
    setSelectedArea('');
  };

  const removeCoupon = async () => {
    setAppliedCoupon(null);
    setCouponDiscount(0);
    setCouponCode('');
    if (promoStorageKey && typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(promoStorageKey);
      } catch {
        // Non-fatal.
      }
    }
    // Free-shipping off at once, Place Order held until the real fee lands —
    // see repriceAfterCouponRemoval (#1807).
    await repriceAfterCouponRemoval({
      setFreeShipping,
      setRepricing: setRepricingShipping,
      calculateShipping,
    });
  };

  // Auto-apply a promo that the user entered on /cart. Runs once after the
  // cart hydrates so the discount is re-validated server-side with the
  // authoritative subtotal.
  const autoAppliedPromoRef = useRef(false);
  useEffect(() => {
    if (autoAppliedPromoRef.current) return;
    if (!cartIsReady || !promoStorageKey || !cart || cart.subtotal === 0) return;
    if (typeof window === 'undefined') return;
    const stored = window.sessionStorage.getItem(promoStorageKey);
    if (!stored) return;
    autoAppliedPromoRef.current = true;
    applyCouponCode(stored);
  }, [cartIsReady, cart, promoStorageKey, applyCouponCode]);

  // Fetch the customer's loyalty balance + redemption settings once we know
  // they're logged in and we have a real store. Public endpoints; silently
  // no-op for guests, disabled loyalty, or stores without the feature.
  useEffect(() => {
    if (!isAuthenticated || !store?.id || store.id === 'demo') {
      setLoyalty(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [pointsRes, infoRes] = await Promise.all([
          api.get<{
            points: { points: number; pointsValue: number } | null;
          }>(`/public/${store.id}/loyalty/my-points`),
          api.get<{
            enabled: boolean;
            pointsValue?: number;
            minRedeemPoints?: number;
            maxRedeemPercentage?: number;
          }>(`/public/${store.id}/loyalty/info`),
        ]);
        if (cancelled) return;
        const pts = pointsRes.success ? pointsRes.data?.points : null;
        const info = infoRes.success ? infoRes.data : null;
        if (!pts || !info?.enabled || pts.points <= 0) {
          setLoyalty(null);
          return;
        }
        setLoyalty({
          points: pts.points,
          pointsValue: info.pointsValue ?? pts.pointsValue ?? 1,
          minRedeemPoints: info.minRedeemPoints ?? 0,
          // The same cap the server's computeRedemption applies (#181). 100
          // only when an older API does not report it — the server still caps
          // the real discount either way.
          maxRedeemPercentage: info.maxRedeemPercentage ?? 100,
        });
      } catch {
        if (!cancelled) setLoyalty(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, store?.id]);

  // Automatic promotion preview (no code required). Server-resolved from
  // the cart's product ids + the shopper's typed phone/email — the
  // storefront cart never carries category ids, so this can't be computed
  // client-side (mirrors couponDiscount's shape: { id, discount } | null).
  const [promotion, setPromotion] = useState<{ id: string; discount: number } | null>(null);
  // Tracks the last signature we actually sent, so an unrelated re-render
  // with the same items/phone/email doesn't refire the request.
  const promotionSignatureRef = useRef<string>('');
  useEffect(() => {
    if (!store?.id || !cart || cart.items.length === 0) {
      setPromotion(null);
      promotionSignatureRef.current = '';
      return;
    }
    const items = cart.items.map(item => ({ productId: item.productId, quantity: item.quantity }));
    const phone = formData.phone.trim() || undefined;
    const email = formData.email.trim() || undefined;
    const signature = JSON.stringify({ storeId: store.id, items, phone, email });
    if (signature === promotionSignatureRef.current) return;

    // Debounce so typing a phone/email doesn't fire a request per keystroke
    // (the endpoint is also rate-limited at 20/min/IP).
    const timeoutId = setTimeout(() => {
      promotionSignatureRef.current = signature;
      api
        .post<{ promotion: { id: string; discount: number } | null }>(
          `/stores/public/${store.id}/promotions/preview`,
          { items, phone, email }
        )
        .then(result => setPromotion(result.success ? (result.data?.promotion ?? null) : null))
        .catch(() => setPromotion(null));
    }, 400);
    return () => clearTimeout(timeoutId);
  }, [store?.id, cart, formData.phone, formData.email]);

  // Calculate totals
  const subtotal = cart?.subtotal || 0;

  // Automatic promotions don't stack with a coupon — mirrors
  // OrderService.create's `primaryDiscount = Math.max(couponDiscount,
  // promotionDiscount)` so this display-only total matches what the server
  // will actually charge. `promotionAppliedDiscount` is the amount OrderSummary
  // should render as its own "Promotion" line — only when the promotion is
  // the winning lever (matches the server's `appliedPromotionId` gate: the
  // promotion wins ties), so we never show a promotion line for a discount
  // that wouldn't actually be the one applied.
  const promotionDiscount = promotion?.discount ?? 0;
  const primaryDiscount = Math.max(couponDiscount, promotionDiscount);
  const promotionAppliedDiscount = promotionDiscount >= couponDiscount ? promotionDiscount : 0;

  // Loyalty discount estimate — the server's computeRedemption, mirrored in
  // estimateLoyaltyRedemption so the summary matches what the API will apply:
  // clamp to balance, gate at the minimum, cap at maxRedeemPercentage% of the
  // goods value remaining after the primary (coupon-or-promotion) discount.
  // The server re-validates; this is display-only.
  const redeemableAfterCoupon = Math.max(0, subtotal - primaryDiscount);
  const { loyaltyDiscount, pointsToSend } =
    redeemEnabled && loyalty
      ? estimateLoyaltyRedemption(loyalty, pointsToRedeem, redeemableAfterCoupon, loyalty.points)
      : { loyaltyDiscount: 0, pointsToSend: 0 };

  const discount = primaryDiscount + loyaltyDiscount;
  const shipping = freeShipping ? 0 : shippingCost;
  // VAT — the SAME formula the API charges at order creation
  // (computeOrderAmounts, rulings M3-9 + MONEYB-2): the taxable base is
  // subtotal net of discount, plus shipping and the COD fee. `taxRatePercent` is already zeroed by the API
  // for a disabled store (resolveActiveTaxRate — the ONE resolver order
  // creation charges against too, since M3-9), so `tax = 0` and the
  // summary renders byte-identically to before this line existed. When
  // the store's prices already include VAT, `includedInPrice` selects
  // EXTRACTION (the same branch order creation uses) and the amount is
  // informational only — NOT added to `total`.
  const taxRatePercent = store?.taxRatePercent ?? 0;
  const taxIncludedInPrice = !!store?.taxIncludedInPrice;
  // Cash-on-delivery fee, shown BEFORE "Place order" (ruling MONEYB-3).
  const codFee =
    selectedProvider.split(':')[0] === 'cod'
      ? codFeeForOrder({ subtotal, discount, shipping }, codFeeConfig)
      : 0;
  // subtotal → discounts → shipping → COD fee → VAT → total, VAT on the whole
  // supply incl. shipping and the COD fee (ruling MONEYB-2) — the function the
  // order is charged with, so this summary is the order's numbers.
  const { tax, total } = computeOrderAmounts({
    subtotal,
    discount,
    shipping,
    codFee,
    ratePercent: taxRatePercent,
    includedInPrice: taxIncludedInPrice,
  });
  // Display estimate of the wallet portion; the server re-resolves it.
  const walletApplied =
    walletSpendable && useWalletBalance && wallet ? Math.min(wallet.balance, total) : 0;

  // Per-store, opt-in minimum order value (Store.settings.minimumOrderFils,
  // piastres; 0/unset = no minimum). Defense-in-depth for direct navigation to
  // /checkout that bypasses the cart page's guard — the API's
  // OrderService.create is the real, hard-blocking check. store.settings is
  // a loose Record — cast the one key we read, same pattern as
  // checkoutDelivery above.
  const minimumOrderFils = store?.settings?.minimumOrderFils as number | undefined;
  const minimumOrderCheck = checkMinimumOrder(subtotal, minimumOrderFils);
  const belowMinimumOrder = !minimumOrderCheck.met;
  // The delivery fee in the summary is confirmed (#2067): no quote in flight,
  // no failed quote, no coupon-removal reprice pending.
  const shippingSettled = isShippingSettled({
    shippingError,
    quotePending: shippingQuotePending,
    repricing: repricingShipping,
  });
  const minimumOrderMessage = belowMinimumOrder
    ? t(
        `Minimum order is ${formatPrice(minimumOrderFils as number)} — add ${formatPrice(minimumOrderCheck.shortfallFils)} more`,
        `الحد الأدنى للطلب ${formatPrice(minimumOrderFils as number)} — أضف ${formatPrice(minimumOrderCheck.shortfallFils)} أخرى`
      )
    : undefined;

  // Submit order
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Defense-in-depth: the cart page already blocks reaching /checkout at
    // all when the subtotal is below the store's minimum order value, but a
    // customer can land here directly (bookmark, back button, stale tab).
    // Block BOTH the step-1 -> step-2 advance and the final order submission
    // — the API's OrderService.create is the real, hard-blocking check.
    if (belowMinimumOrder) {
      setCheckoutError(minimumOrderMessage ?? null);
      return;
    }

    // An unavailable line can never be ordered — say so now rather than let the
    // shopper fill both steps and meet the server's refusal (#2117).
    if (unavailableLinesNotice) {
      setCheckoutError(unavailableLinesNotice);
      return;
    }

    // Never advance or submit on a delivery fee that was not confirmed
    // (#2067). A failed quote sends the customer back to step 1, where the
    // delivery panel carries the "couldn't calculate shipping — Retry"
    // control; an in-flight quote simply waits.
    if (!shippingSettled) {
      if (shippingError) {
        setCheckoutError(
          t(
            "We couldn't confirm the delivery fee. Please retry shipping before placing your order.",
            'تعذّر تأكيد رسوم التوصيل. يرجى إعادة حساب الشحن قبل إتمام الطلب.'
          )
        );
        setStep(1);
      }
      return;
    }

    if (step === 1) {
      // Validate before proceeding to payment
      if (!validateForm()) {
        // Scroll to first error
        const firstError = document.querySelector('[data-error="true"]');
        firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      // The ONLY shipping condition that blocks checkout: the store configured
      // per-area rates and this area is genuinely not covered. Free / zero-cost
      // shipping (incl. unconfigured stores) must always be allowed through.
      if (shippingUnavailable) {
        return;
      }
      setStep(2);
      return;
    }

    // #776: `nowMinutes` above ticks every 30s, so it can still be up to a
    // tick behind. Re-read the clock right before validating/using the
    // window, so submission always checks it against "now"; on a lapse the
    // reading is written back to `nowMinutes` so the picker agrees with the
    // refusal (#2047/#2050).
    const submitNowMinutes = getNowMinutesInTimezone(storeTimezone);
    const freshDeliverySelection = checkoutDelivery?.windows?.enabled
      ? resolveDeliverySelection(checkoutDelivery.windows.items, submitNowMinutes)
      : { day: 'today' as const, windows: [] };
    const freshAnyWindowAvailable = freshDeliverySelection.windows.some(w => w.available);
    const freshSelectedWindow = findStillBookableWindow(
      freshDeliverySelection,
      selectedDeliveryWindowId,
      selectedDeliveryDay
    );
    // The picked window lapsed (or the picker rolled over to tomorrow) since
    // it was chosen. Move the picker onto the same clock so the lapsed window
    // renders closed, drop the choice, and say WHY — then stop: the customer
    // re-picks from what is actually bookable (#2047/#2050). Never ship the
    // order without the slot they believe they booked.
    if (checkoutDelivery?.windows?.enabled && selectedDeliveryWindowId && !freshSelectedWindow) {
      setNowMinutes(submitNowMinutes);
      setSelectedDeliveryWindowId(null);
      setSelectedDeliveryDay(null);
      setDeliveryWindowError(lapsedWindowMessage);
      const firstError = document.querySelector('[data-error="true"]');
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Delivery window is required only when the store enabled windows AND at
    // least one is actually available NOW — when none are available the
    // "no windows today" message shows and the order proceeds unselected
    // (per the platform rule: never hard-block checkout on this).
    if (checkoutDelivery?.windows?.enabled && freshAnyWindowAvailable && !freshSelectedWindow) {
      setDeliveryWindowError(t('Please select a delivery window', 'يرجى اختيار موعد التوصيل'));
      const firstError = document.querySelector('[data-error="true"]');
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setDeliveryWindowError(null);

    setIsProcessing(true);
    setCheckoutError(null);

    // Persist or clear saved info based on the saveInfo checkbox.
    if (store?.id) {
      const selectedGovForSave = EGYPT_GOVERNORATES.find(g => g.en === formData.governorate);
      const selectedAreaForSave =
        selectedGovForSave?.areas.find(a => a.en === formData.area) ??
        findGovernorateByArea(formData.area)?.areas.find(a => a.en === formData.area);
      // Fallback to rate-row AR names for custom areas/governorates not in the static list.
      const rateRowForSave = rateByArea.get(formData.area);
      if (saveInfo) {
        saveCheckoutInfo(store.id, {
          firstName: formData.firstName,
          lastName: formData.lastName,
          phone: formData.phone,
          email: formData.email,
          governorate: selectedGovForSave?.en ?? formData.governorate,
          governorateAr: selectedGovForSave?.ar ?? rateRowForSave?.governorateAr ?? '',
          area: selectedAreaForSave?.en ?? formData.area,
          areaAr: selectedAreaForSave?.ar ?? rateRowForSave?.areaAr ?? '',
          street: formData.street,
          building: formData.building,
          floor: formData.floor,
          apartment: formData.apartment,
          landmark: formData.landmark,
          notes: formData.notes,
        });
      } else {
        clearCheckoutInfo(store.id);
      }
    }

    // The order this attempt created, once it exists — so a payment-leg
    // refusal can point at it instead of at a fresh checkout (#1826).
    let createdOrderId: string | null = null;

    try {
      // Create order. Include the form's email on the shipping address so
      // the invoice / order confirmation can show the *buyer's* contact email
      // — not the authenticated user's profile email (which can differ when
      // a logged-in admin checks out for someone else).
      // Resolve both English and Arabic names.
      // For Egypt areas, prefer the static canonical data; for custom areas
      // (not in the static list), fall back to the rate-row AR names.
      const selectedGov = EGYPT_GOVERNORATES.find(g => g.en === formData.governorate);
      const selectedEgyptArea =
        selectedGov?.areas.find(a => a.en === formData.area) ??
        findGovernorateByArea(formData.area)?.areas.find(a => a.en === formData.area);
      const rateRow = rateByArea.get(formData.area);

      // Compose address1 from structured fields for back-compat with
      // existing order display / admin views.
      // Labels in the shopper's language so an Arabic address never reads
      // "شارع النصر, Building 5" on the invoice and the courier label.
      const address1Parts = [
        formData.street,
        formData.building ? `${t('Building', 'مبنى')} ${formData.building}` : '',
        formData.floor ? `${t('Floor', 'الدور')} ${formData.floor}` : '',
        formData.apartment ? `${t('Apt', 'شقة')} ${formData.apartment}` : '',
      ].filter(Boolean);
      const composedAddress1 =
        address1Parts.join(language === 'ar' ? '، ' : ', ') || formData.address;

      // Persist the chosen delivery window (+ day) on the order via `notes`
      // — there's no dedicated column for it. Prepended so it's the first
      // thing the merchant sees; localized to the label/day the customer
      // actually picked from (not necessarily their current UI language at
      // read time). The day matters once rollover is in play: a window
      // picked after today's cutoff is for TOMORROW, not today.
      //
      // Uses `freshSelectedWindow`/`freshDeliverySelection` (computed above
      // against submit-time "now"), not the mount-time memoized
      // `deliverySelection` — see the #776 comment above.
      const selectedDeliveryWindow = freshSelectedWindow;
      const deliveryDayLabel =
        freshDeliverySelection.day === 'tomorrow' ? t('Tomorrow', 'غدًا') : t('Today', 'اليوم');
      const notesWithDelivery = selectedDeliveryWindow
        ? `${t('Delivery', 'التوصيل')}: ${deliveryDayLabel}, ${
            language === 'ar' ? selectedDeliveryWindow.labelAr : selectedDeliveryWindow.label
          } (${formatWindowTime(selectedDeliveryWindow.start, language)}–${formatWindowTime(
            selectedDeliveryWindow.end,
            language
          )})\n${formData.notes}`
        : formData.notes;

      const orderResult = await api.createOrder({
        shippingAddress: {
          firstName: formData.firstName,
          lastName: formData.lastName,
          address1: composedAddress1,
          address2: formData.landmark,
          // Structured address fields — custom area AR names fall back to the rate row.
          area: selectedEgyptArea?.en ?? formData.area,
          areaAr: selectedEgyptArea?.ar ?? rateRow?.areaAr ?? '',
          governorate: selectedGov?.en ?? formData.governorate,
          governorateAr: selectedGov?.ar ?? rateRow?.governorateAr ?? '',
          // Additional structured fields for delivery logistics
          street: formData.street,
          building: formData.building,
          floor: formData.floor,
          apartment: formData.apartment,
          city: '',
          // Use the country from the rate row when available (multi-country stores),
          // falling back to "Egypt" — matches the Address.country default + the
          // "Egypt" value every Egypt rate row carries (don't mix legacy codes / "Egypt").
          country: rateRow?.country ?? REGION.countryName.en,
          phone: formData.phone,
          email: formData.email,
        },
        // The provider only: the method (card / Meeza / ...) belongs to /payments/create.
        paymentMethod: selectedProvider.split(':')[0],
        notes: notesWithDelivery,
        couponCode: appliedCoupon?.code,
        // Only send a redemption request when the customer opted in AND the
        // amount clears the store minimum. The server re-validates against the
        // real balance + caps regardless.
        pointsToRedeem: pointsToSend > 0 ? pointsToSend : undefined,
        // Only sent when the customer ticked "Use wallet balance" on a store
        // where the API reports wallet checkout as available.
        useWallet: walletApplied > 0 ? true : undefined,
        // Only an explicit tick on a rendered box is sent; omitted otherwise.
        smsOptIn: showSmsOptIn && smsOptIn ? true : undefined,
      });

      if (!orderResult.success || !orderResult.data?.order) {
        // Throw the API error CODE (not message) so the catch maps it to
        // customer-friendly copy. Raw message goes to console only. We also
        // attach the API's field-level `details` (Zod -> {field: [msg]}) so
        // the catch block can surface a meaningful inline message instead of
        // a generic "Something went wrong" toast when validation fails.
        const err = new Error(orderResult.error?.code || 'ORDER_CREATE_FAILED');
        (err as Error & { rawMessage?: string }).rawMessage = orderResult.error?.message || '';
        (err as Error & { details?: Record<string, string[]> }).details =
          orderResult.error?.details;
        throw err;
      }

      const order = orderResult.data.order;
      createdOrderId = order.id;

      // Paid in full from the customer wallet: the order was created paid and
      // there is nothing left for a gateway — /payments/create would refuse it.
      // Go straight to the success page.
      const orderWalletAmount = order.walletAmount ?? 0;
      if (orderWalletAmount > 0 && orderWalletAmount >= order.total) {
        if (typeof window !== 'undefined') {
          try {
            if (checkoutStorageKey) window.sessionStorage.removeItem(checkoutStorageKey);
            if (promoStorageKey) window.sessionStorage.removeItem(promoStorageKey);
          } catch {
            // Non-fatal
          }
        }
        refreshWallet();
        // The success page's verify-on-return answers "paid" straight from
        // the order's paymentStatus for this order — no gateway round-trip.
        router.push(storeUrl(`/checkout/success?orderId=${order.id}`));
        return;
      }

      // Create payment.
      // Send RELATIVE paths so the api can absolutify them against the order's
      // resolved storefront base url (custom domain or slug). Sending absolute
      // urls with the store's custom domain trips the schema's platform-origin
      // refinement, which is intended to block open-redirect attacks.
      const [selectedProviderId, selectedMethod] = selectedProvider.split(':');
      const paymentResult = await api.post<{
        paymentUrl?: string;
        cod?: boolean;
        instruction?: { kind: string; code?: string; expiresAt?: string };
      }>('/payments/create', {
        orderId: order.id,
        provider: selectedProviderId,
        ...(selectedMethod ? { method: selectedMethod } : {}),
        successUrl: `/checkout/success?orderId=${order.id}`,
        errorUrl: `/checkout/error?orderId=${order.id}`,
      });

      // Success clears the saved checkout form and promo code before leaving
      // the page, so they don't leak into the next order. A failure keeps
      // them (the order was rolled back and the cart restored, so the
      // customer retries with the same details) and throws the API error
      // code into the catch below, which maps it to customer copy (#1990).
      handlePaymentCreateResult(paymentResult, {
        clearSavedCheckout: () => {
          if (typeof window === 'undefined') return;
          try {
            if (checkoutStorageKey) window.sessionStorage.removeItem(checkoutStorageKey);
            if (promoStorageKey) window.sessionStorage.removeItem(promoStorageKey);
          } catch {
            // Non-fatal
          }
        },
        goToCodSuccess: () => router.push(storeUrl(`/checkout/success?orderId=${order.id}&cod=1`)),
        goToInstapay: () =>
          router.push(storeUrl(`/checkout/success?orderId=${order.id}&instapay=1`)),
        goToReferenceCode: code =>
          router.push(
            storeUrl(`/checkout/success?orderId=${order.id}&ref=${encodeURIComponent(code)}`)
          ),
        goToGateway: paymentUrl => {
          window.location.href = paymentUrl;
        },
      });
    } catch (error) {
      // Log the technical detail for debugging — never show it to the customer.
      const raw =
        error instanceof Error
          ? ((error as Error & { rawMessage?: string }).rawMessage ?? error.message)
          : String(error);
      console.error('Checkout error:', raw);

      // Map known backend error codes to friendly customer copy. Anything
      // unrecognized falls through to a generic "try again" message —
      // customers never see internal terminology like "provider not
      // configured" or "schema validation".
      const code = error instanceof Error ? error.message : '';
      const details =
        error instanceof Error
          ? (error as Error & { details?: Record<string, string[]> }).details
          : undefined;

      // Map server-side field paths (e.g. "shippingAddress.email") to our
      // checkout form fields and route the user back to step 1 with the
      // offending field highlighted. This handles the case where a customer
      // somehow gets past client-side validation (corrupted sessionStorage,
      // pasted text with control chars, etc.) and the API rejects the order.
      if (code === 'VALIDATION_ERROR' && details) {
        const fieldMap: Record<string, keyof typeof formErrors> = {
          'shippingAddress.email': 'email',
          'shippingAddress.firstName': 'firstName',
          'shippingAddress.lastName': 'lastName',
          'shippingAddress.phone': 'phone',
          'shippingAddress.address1': 'address',
          'shippingAddress.state': 'area',
          'shippingAddress.area': 'area',
          'shippingAddress.governorate': 'governorate',
          'shippingAddress.street': 'street',
          'shippingAddress.building': 'building',
        };
        const inlineErrors: typeof formErrors = {};
        for (const [path, msgs] of Object.entries(details)) {
          const localField = fieldMap[path];
          if (localField && msgs?.[0]) {
            // Translate common Zod messages to user-facing Arabic when needed.
            // Anything we don't recognize falls through to the raw message —
            // better than the generic "Something went wrong" toast.
            const rawMsg = msgs[0];
            let translated = rawMsg;
            if (/email/i.test(rawMsg)) {
              translated = t('Please enter a valid email address', 'يرجى إدخال بريد إلكتروني صحيح');
            } else if (/required|min|too small|expected/i.test(rawMsg)) {
              translated = t('This field is required', 'هذا الحقل مطلوب');
            } else if (/too big|max|too large/i.test(rawMsg)) {
              translated = t('This value is too long', 'القيمة المُدخلة طويلة جداً');
            }
            inlineErrors[localField] = translated;
          }
        }
        if (Object.keys(inlineErrors).length > 0) {
          setFormErrors(prev => ({ ...prev, ...inlineErrors }));
          setStep(1);
          // Scroll the first inline error into view on the shipping step.
          setTimeout(() => {
            const firstError = document.querySelector('[data-error="true"]');
            firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 50);
          setCheckoutError(
            t(
              'Please fix the highlighted fields and try again.',
              'يرجى تصحيح الحقول المميّزة والمحاولة مرة أخرى.'
            )
          );
          setIsProcessing(false);
          return;
        }
      }

      // Bundle-specific checkout failures get their own copy naming the
      // bundle — BUNDLE_NOT_PURCHASABLE and a bundle-component
      // INSUFFICIENT_INVENTORY are otherwise either unhandled (falls to the
      // fully generic default below) or handled only generically (doesn't
      // say which box). Must run BEFORE the switch: it already has its own
      // (non-bundle-specific) INSUFFICIENT_INVENTORY case that would
      // otherwise shadow this. See checkout-bundle-errors.ts.
      const bundleFriendly = checkoutBundleErrorCopy(code, raw, t);
      if (bundleFriendly) {
        setCheckoutError(bundleFriendly);
        setIsProcessing(false);
        return;
      }

      // The store's subscription ended (402): a shopper-facing message, not the merchant-directed one.
      const subscriptionFriendly = subscriptionRequiredCopy(code, t);
      if (subscriptionFriendly) {
        setCheckoutError(subscriptionFriendly);
        setIsProcessing(false);
        return;
      }

      let friendly: string;
      switch (code) {
        case 'MANUAL_HOLD_NOT_ADMITTED':
          friendly = t(
            'To use cash on delivery or InstaPay, return to checkout and choose that method when placing a new order.',
            'للدفع عند الاستلام أو عبر إنستاباي، ارجع إلى إتمام الطلب واختر طريقة الدفع عند إنشاء طلب جديد.'
          );
          break;
        case 'TOO_MANY_OPEN_HOLDS':
          friendly = t(
            'You have too many orders awaiting payment. Complete or cancel an existing order before placing another.',
            'لديك طلبات كثيرة بانتظار الدفع. أكمل طلباً حالياً أو ألغِه قبل إنشاء طلب آخر.'
          );
          break;
        case 'COD_NOT_AVAILABLE':
          friendly = t(
            'Cash on delivery is currently unavailable. Please choose another payment method.',
            'الدفع عند الاستلام غير متاح حالياً. يرجى اختيار طريقة دفع أخرى.'
          );
          break;
        case 'COD_FEE_NOT_QUOTED':
          // The order was priced without the cash-on-delivery fee (MONEYB-3);
          // it was rolled back, so placing it again shows the fee first.
          friendly = t(
            'The cash-on-delivery fee was not included in your total. Your cart is back — review the total with the fee and place the order again.',
            'لم تُحتسب رسوم الدفع عند الاستلام في الإجمالي. أعدنا سلتك كما كانت — راجع الإجمالي مع الرسوم ثم أكّد الطلب مرة أخرى.'
          );
          break;
        case 'PAYMENT_PROVIDER_ERROR':
          friendly = t(
            'We could not start your payment. Please try again or choose another payment method.',
            'تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى أو اختيار طريقة دفع أخرى.'
          );
          break;
        case 'PAYMENT_METHOD_UNAVAILABLE':
          // One method is down (circuit open): the cart was restored, the others still work.
          friendly = t(
            'This payment method is temporarily unavailable. Please choose another one, such as cash on delivery or InstaPay.',
            'طريقة الدفع هذه غير متاحة مؤقتاً. يرجى اختيار طريقة أخرى مثل الدفع عند الاستلام أو إنستاباي.'
          );
          break;
        case 'INSTAPAY_NOT_AVAILABLE':
          friendly = t(
            'InstaPay is not available for this store right now. Please choose another payment method.',
            'إنستاباي غير متاح لهذا المتجر حالياً. يرجى اختيار طريقة دفع أخرى.'
          );
          break;
        case 'PAYMENT_PROVIDER_NOT_CONFIGURED':
        case 'PAYMENT_NOT_CONFIGURED':
          friendly = t(
            'This payment method is not available right now. Please choose another option.',
            'طريقة الدفع هذه غير متاحة حالياً. يرجى اختيار طريقة أخرى.'
          );
          break;
        case 'EMPTY_CART':
          friendly = t(
            'Your cart is empty. Please add items before checking out.',
            'سلة التسوق فارغة. يرجى إضافة منتجات قبل إتمام الشراء.'
          );
          break;
        // A cart line whose product the merchant has since deleted. Before
        // this case the customer fell to the generic "please try again",
        // which can NEVER succeed — the product is gone, so every retry
        // refuses identically. Send them back to the cart, which is the only
        // place the line can be removed.
        //
        // The server sends the offending ids in `details.productIds`, not in
        // the message: a raw UUID is neither translatable nor meaningful to a
        // shopper. They are read here so the count picks singular vs plural
        // copy, and so the cart page can mark the lines.
        case PRODUCT_NO_LONGER_AVAILABLE: {
          const goneIds = unavailableProductIds({
            code,
            details: details as { productIds?: unknown } | null | undefined,
          });
          // Resolve the ids to NAMES off the cart we are already holding.
          //
          // The ids used to be parsed and dropped — only `length` survived, to
          // pick singular vs plural. That left a customer with a six-item cart
          // removing lines by guess-and-check and re-entering checkout after
          // each one. The cart line for each id is right here, so the message
          // can say which products rather than making the shopper find them.
          //
          // `pickProductName` falls back to `name` when `nameAr` is untranslated
          // (empty string, not just missing) — a merchant may not have
          // translated every product, and an untranslated one should still say
          // its (English) name rather than resolving to '' and quietly
          // downgrading the whole message to the partial "Including" framing
          // (#1805). `productUnavailableCopy` still drops any name that truly
          // cannot be resolved and says "Including" rather than "Remove" for
          // that case, so a name we genuinely don't have never turns the
          // sentence into a false promise.
          const goneNames = goneIds
            .map(id => cartContextItems.find(item => item.productId === id))
            .filter((line): line is NonNullable<typeof line> => Boolean(line))
            .map(line => pickProductName(line, language));
          friendly = productUnavailableCopy(t, goneIds.length, goneNames);
          // #1766: pull the server cart so the lines are marked "no longer
          // available" (and out of the total) when the shopper opens the cart.
          void refetchCart().catch(() => undefined);
          // Safe now: <CheckoutErrorAlert> renders above BOTH steps, so this
          // message survives the unmount of PaymentStep. Before that it did not.
          setStep(1);
          break;
        }
        // A concurrent spend (another tab/device) drained the wallet between
        // the summary and the order: the server refused and rolled the whole
        // order back. Refresh the balance so the summary tells the truth.
        case 'INSUFFICIENT_WALLET_BALANCE':
          friendly = t(
            'Your wallet balance changed. Please review your order and try again.',
            'تغيّر رصيد محفظتك. يرجى مراجعة طلبك والمحاولة مرة أخرى.'
          );
          refreshWallet();
          setUseWalletBalance(false);
          break;
        case 'COUPON_LIMIT_REACHED':
          friendly = t(
            'The coupon you applied has reached its usage limit. Please remove it and try again.',
            'تم استخدام الكوبون الذي طبّقته بالكامل. يرجى إزالته والمحاولة مرة أخرى.'
          );
          break;
        case 'COUPON_NOT_ELIGIBLE':
          // `OrderService.create` refuses with this whenever the coupon does
          // not apply to the cart as the SERVER prices it — which free-shipping
          // coupons now reach routinely. It fell to `default` ("please try
          // again"), and retrying refused identically: the coupon was still
          // applied, still in sessionStorage, and re-applied on every reload.
          // A deterministic dead-end dressed as a transient failure.
          //
          // So remove it here rather than only telling the customer to. The
          // sessionStorage key is the load-bearing half — without dropping it,
          // the promo re-applies on the next mount and the next submit fails
          // the same way.
          //
          // AWAITED, and the customer is sent back to review: the removal
          // changes the total (a free-shipping coupon's delivery fee comes
          // back), so re-enabling Place Order before the recomputed fee lands
          // let a fast retry charge a fee the summary still showed as free.
          await removeCoupon();
          setStep(1);
          friendly = t(
            'This coupon does not apply to the items in your cart, so it has been removed. Please try again.',
            'هذا الكوبون لا ينطبق على المنتجات في سلتك، لذلك تمت إزالته. يرجى المحاولة مرة أخرى.'
          );
          break;
        case 'MIN_ORDER_NOT_MET':
          friendly = t(
            'Your order does not meet the minimum amount required for this coupon.',
            'طلبك لا يستوفي الحد الأدنى للمبلغ المطلوب لهذا الكوبون.'
          );
          break;
        case 'MINIMUM_ORDER_NOT_MET':
          // The client-side guard should already have blocked this before
          // the API call — reached only on stale cart data or a direct
          // request. Send the customer back to review their cart.
          friendly =
            minimumOrderMessage ??
            t(
              'Your cart does not meet this store’s minimum order value.',
              'سلتك لا تستوفي الحد الأدنى لقيمة الطلب لهذا المتجر.'
            );
          setStep(1);
          break;
        case 'INSUFFICIENT_INVENTORY':
          friendly = t(
            'One of the items in your cart is out of stock. Please review your cart.',
            'أحد المنتجات في سلتك غير متوفر. يرجى مراجعة سلة التسوق.'
          );
          break;
        case 'AREA_NOT_DELIVERABLE':
          // The store prices delivery per area and the selected one matches no
          // rate, so the order is refused rather than shipped at 0. The
          // storefront hides unpriced areas, so reaching this means the saved
          // address predates the merchant's current rates — deterministic
          // until the customer picks a different area, which is the shipping
          // step, not this one.
          friendly = t(
            'This store does not deliver to the area you selected. Please choose a different area.',
            'هذا المتجر لا يوصل إلى المنطقة التي اخترتها. يرجى اختيار منطقة أخرى.'
          );
          setStep(1);
          break;
        case 'ORDER_ALREADY_PAID':
          // Payment leg (#1826): this order already has a settled payment —
          // a double submit, or a payment that landed while the page waited.
          // Paying again is the one thing that must not happen, so this is
          // NOT a retry: show the order's confirmation, which verifies its
          // status with the server.
          friendly = t(
            'This order has already been paid. Opening your order confirmation…',
            'تم دفع هذا الطلب بالفعل. جارٍ فتح تأكيد طلبك…'
          );
          if (createdOrderId) {
            router.push(storeUrl(`/checkout/success?orderId=${createdOrderId}`));
          }
          break;
        case 'TIMEOUT':
          friendly = t(
            'The server took too long to respond. Please try again.',
            'استغرق الخادم وقتاً طويلاً للاستجابة. يرجى المحاولة مرة أخرى.'
          );
          break;
        case 'VALIDATION_ERROR':
          // Reached when the API rejects the payload but didn't include
          // `details` — point the customer back to the shipping step so they
          // can review what they typed.
          friendly = t(
            'Some of the information you entered looks invalid. Please review your shipping details and try again.',
            'بعض المعلومات التي أدخلتها غير صحيحة. يرجى مراجعة بيانات الشحن والمحاولة مرة أخرى.'
          );
          setStep(1);
          break;
        default:
          friendly = t(
            'Something went wrong while processing your order. Please try again or contact support if the problem persists.',
            'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى أو التواصل مع الدعم إذا استمرت المشكلة.'
          );
      }
      setCheckoutError(friendly);
      setIsProcessing(false);
    }
  };

  if (isLoading || !cartIsReady) {
    return (
      <MinimalChrome label={checkoutLabelEn} labelAr={checkoutLabelAr}>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
            <p className="text-sm text-muted-foreground">
              {t('Loading checkout...', 'جارٍ التحميل...')}
            </p>
          </div>
        </div>
      </MinimalChrome>
    );
  }

  if (cart && cart.items.length === 0 && cart.bundles.length === 0 && unavailableLinesNotice) {
    // Every line in the cart is unorderable (#2116). NOT "your cart is empty":
    // the lines are still there and /cart is the only place to remove them.
    return (
      <MinimalChrome label={checkoutLabelEn} labelAr={checkoutLabelAr}>
        <div
          className="mx-auto max-w-7xl px-4 py-16 text-center"
          data-checkout-nothing-orderable=""
        >
          <h1 className="text-2xl font-bold text-foreground">
            {t('Nothing in your cart can be ordered', 'لا يمكن طلب أي منتج في سلتك')}
          </h1>
          <p role="alert" className="mt-2 text-muted-foreground">
            {unavailableLinesNotice}
          </p>
          <Link href={storeUrl('/cart')}>
            <Button className="mt-6">{t('Go to cart', 'الذهاب إلى السلة')}</Button>
          </Link>
        </div>
      </MinimalChrome>
    );
  }

  if (!cart || (cart.items.length === 0 && cart.bundles.length === 0)) {
    return (
      <MinimalChrome label={checkoutLabelEn} labelAr={checkoutLabelAr}>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-foreground">
            {t('Your cart is empty', translations['Your cart is empty'])}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Add some products before checking out.',
              '\u0623\u0636\u0641 \u0628\u0639\u0636 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062f\u0641\u0639.'
            )}
          </p>
          <Link href={continueShoppingHref}>
            <Button className="mt-6">
              {t('Continue Shopping', translations['Continue Shopping'])}
            </Button>
          </Link>
        </div>
      </MinimalChrome>
    );
  }

  // Derive single-country display values for the static Country row.
  // When the store has rates for >1 distinct country, the country selector
  // renders inside GovernorateAreaSelect instead and this row is hidden.
  const distinctRatedCountries =
    allAreaRates.length > 0
      ? [...new Set(allAreaRates.map(r => r.country))]
      : [REGION.countryName.en];
  const isSingleCountryStore = distinctRatedCountries.length <= 1;
  const singleCountryEn = distinctRatedCountries[0] ?? REGION.countryName.en;
  const singleCountryAr =
    allAreaRates.find(r => r.country === singleCountryEn)?.countryAr ?? REGION.countryName.ar;

  return (
    <MinimalChrome label={checkoutLabelEn} labelAr={checkoutLabelAr}>
      <div className="flex-1" style={checkoutBgStyle}>
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8" style={checkoutDensity}>
          {/* Progress Steps */}
          <div className="mb-8">
            <div className="flex items-center justify-center">
              {/* Step 1: Shipping -- clickable when user is on step 2 (completed step) */}
              <button
                type="button"
                onClick={() => {
                  if (step > 1) setStep(1);
                }}
                disabled={step <= 1}
                className={`flex items-center ${
                  step > 1 ? 'cursor-pointer group' : 'cursor-default'
                }`}
              >
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    step >= 1 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'
                  } ${step > 1 ? 'group-hover:bg-primary/80' : ''}`}
                >
                  {step > 1 ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    1
                  )}
                </div>
                <span
                  className={`ms-2 text-sm font-medium transition-colors ${
                    step >= 1 ? 'text-foreground' : 'text-muted-foreground'
                  } ${step > 1 ? 'group-hover:text-primary' : ''}`}
                >
                  {t('Shipping', translations['Shipping'])}
                </span>
              </button>
              <div className={`mx-4 h-0.5 w-16 ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
              {/* Step 2: Payment -- current or future step, not clickable */}
              <div className="flex items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                    step >= 2 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  2
                </div>
                <span
                  className={`ms-2 text-sm font-medium ${
                    step >= 2 ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {t('Payment', '\u0627\u0644\u062f\u0641\u0639')}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col lg:grid lg:grid-cols-12 lg:gap-8">
            {/* Form */}
            <div className="order-1 lg:order-none lg:col-span-8">
              <form id="checkout-shipping-form" onSubmit={handleSubmit}>
                {unavailableLinesNotice && !checkoutError && (
                  <div
                    role="alert"
                    data-checkout-unavailable-banner=""
                    className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive-ink"
                  >
                    <p>{unavailableLinesNotice}</p>
                    <Link href={storeUrl('/cart')} className="mt-1 inline-block underline">
                      {t('Go to cart', 'الذهاب إلى السلة')}
                    </Link>
                  </div>
                )}
                <CheckoutErrorAlert
                  message={checkoutError}
                  onClear={() => setCheckoutError(null)}
                />
                {step === 1 && (
                  <div className="rounded-xl border bg-card p-6 shadow-sm">
                    <h2
                      className="text-lg font-semibold text-foreground"
                      style={zoneStyle(checkoutHeadingZone, checkoutScale)}
                    >
                      {t(
                        'Shipping Information',
                        '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0634\u062d\u0646'
                      )}
                    </h2>

                    <div className="mt-6 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div data-error={!!formErrors.firstName}>
                          <Input
                            label={t(
                              'First name',
                              '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
                            )}
                            autoComplete="given-name"
                            value={formData.firstName}
                            onChange={e => updateField('firstName', e.target.value)}
                            aria-invalid={formErrors.firstName ? true : undefined}
                            className={
                              formErrors.firstName
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : ''
                            }
                          />
                          {formErrors.firstName && (
                            <p role="alert" className="mt-1 text-sm text-destructive-ink">
                              {formErrors.firstName}
                            </p>
                          )}
                        </div>
                        <div data-error={!!formErrors.lastName}>
                          <Input
                            label={t(
                              'Last name',
                              '\u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0626\u0644\u0629'
                            )}
                            autoComplete="family-name"
                            value={formData.lastName}
                            onChange={e => updateField('lastName', e.target.value)}
                            aria-invalid={formErrors.lastName ? true : undefined}
                            className={
                              formErrors.lastName
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : ''
                            }
                          />
                          {formErrors.lastName && (
                            <p role="alert" className="mt-1 text-sm text-destructive-ink">
                              {formErrors.lastName}
                            </p>
                          )}
                        </div>
                      </div>

                      <div data-error={!!formErrors.phone}>
                        <Input
                          label={t('Phone', translations['Phone'])}
                          type="tel"
                          autoComplete="tel"
                          inputMode="tel"
                          placeholder={REGION.phone.placeholderIntl}
                          value={formData.phone}
                          onChange={e => updateField('phone', e.target.value)}
                          aria-invalid={formErrors.phone ? true : undefined}
                          className={
                            formErrors.phone
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.phone && (
                          <p role="alert" className="mt-1 text-sm text-destructive-ink">
                            {formErrors.phone}
                          </p>
                        )}
                        {showSmsOptIn && (
                          <label
                            data-sms-marketing-optin
                            className="mt-2 flex cursor-pointer items-start gap-2"
                          >
                            <input
                              type="checkbox"
                              checked={smsOptIn}
                              onChange={e => setSmsOptIn(e.target.checked)}
                              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary accent-primary focus:ring-2 focus:ring-primary/20"
                            />
                            <span className="flex flex-col gap-0.5">
                              <span className="text-sm text-foreground">
                                {t('Send me offers by SMS', translations['Send me offers by SMS'])}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t(
                                  'Promotional messages only. You can stop them anytime.',
                                  translations[
                                    'Promotional messages only. You can stop them anytime.'
                                  ]
                                )}
                              </span>
                            </span>
                          </label>
                        )}
                      </div>

                      <div data-error={!!formErrors.email}>
                        <Input
                          label={t(
                            'Email (optional)',
                            '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                          )}
                          type="email"
                          autoComplete="email"
                          inputMode="email"
                          value={formData.email}
                          onChange={e => updateField('email', e.target.value)}
                          aria-invalid={formErrors.email ? true : undefined}
                          className={
                            formErrors.email
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.email && (
                          <p role="alert" className="mt-1 text-sm text-destructive-ink">
                            {formErrors.email}
                          </p>
                        )}
                      </div>

                      {/* Country row \u2014 fixed display for single-country stores.
                          Multi-country stores get an interactive selector inside GovernorateAreaSelect. */}
                      {isSingleCountryStore && (
                        <div>
                          <label className="block text-sm font-medium text-foreground mb-1">
                            {t('Country', '\u0627\u0644\u0628\u0644\u062f')}
                          </label>
                          <div className="flex items-center rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                            {t(singleCountryEn, singleCountryAr)}
                          </div>
                        </div>
                      )}

                      {/* Governorate \u2192 Area typeahead cascade (+ optional country selector for multi-country stores) */}
                      <GovernorateAreaSelect
                        governorate={formData.governorate}
                        area={formData.area}
                        onChange={handleGovernorateAreaChange}
                        locale={language as 'ar' | 'en'}
                        ratedAreas={ratedAreas.size > 0 ? ratedAreas : undefined}
                        ratedGovernorates={
                          ratedGovernorates.size > 0 ? ratedGovernorates : undefined
                        }
                        areaRates={allAreaRates.length > 0 ? allAreaRates : undefined}
                        governorateError={formErrors.governorate}
                        areaError={formErrors.area}
                      />

                      {/* Delivery method panel */}
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-sm font-medium text-foreground mb-2">
                          {t(
                            'Delivery method',
                            '\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062a\u0648\u0635\u064a\u0644'
                          )}
                        </p>
                        {!formData.area ? (
                          <p className="text-sm text-muted-foreground">
                            {t(
                              'Select your address to see delivery options',
                              '\u062d\u062f\u062f \u0639\u0646\u0648\u0627\u0646\u0643 \u0644\u0639\u0631\u0636 \u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062a\u0648\u0635\u064a\u0644'
                            )}
                          </p>
                        ) : shippingUnavailable ? (
                          <p className="text-sm text-destructive-ink">
                            {t(
                              'Not available for delivery to this area',
                              '\u063a\u064a\u0631 \u0645\u062a\u0627\u062d \u0644\u0644\u062a\u0648\u0635\u064a\u0644 \u0644\u0647\u0630\u0647 \u0627\u0644\u0645\u0646\u0637\u0642\u0629'
                            )}
                          </p>
                        ) : shippingError ? (
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-destructive-ink">
                              {t(
                                "Couldn't calculate shipping. Please retry.",
                                '\u062a\u0639\u0630\u0651\u0631 \u062d\u0633\u0627\u0628 \u0627\u0644\u0634\u062d\u0646. \u064a\u0631\u062c\u0649 \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629.'
                              )}
                            </p>
                            <button
                              type="button"
                              onClick={() => calculateShipping()}
                              className="text-sm font-medium text-primary underline"
                            >
                              {t(
                                'Retry',
                                '\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
                              )}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-foreground">
                              {t(
                                'Standard delivery',
                                '\u062a\u0648\u0635\u064a\u0644 \u0639\u0627\u062f\u064a'
                              )}
                            </span>
                            <span className="text-sm font-medium text-foreground">
                              {freeShipping
                                ? t('Free', '\u0645\u062c\u0627\u0646\u064a')
                                : shippingCost > 0
                                  ? formatPrice(shippingCost)
                                  : rateByArea.has(formData.area)
                                    ? formatPrice(rateByArea.get(formData.area)!.deliveryFee)
                                    : !storeHasAreaRates
                                      ? t('Free', '\u0645\u062c\u0627\u0646\u064a')
                                      : t(
                                          'Calculating...',
                                          '\u062c\u0627\u0631\u064d \u0627\u0644\u062d\u0633\u0627\u0628...'
                                        )}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Structured Egyptian address fields */}
                      <div data-error={!!formErrors.street}>
                        <Input
                          label={t('Street *', 'اسم الشارع *')}
                          autoComplete="address-line1"
                          value={formData.street}
                          onChange={e => updateField('street', e.target.value)}
                          aria-invalid={formErrors.street ? true : undefined}
                          className={
                            formErrors.street
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.street && (
                          <p role="alert" className="mt-1 text-sm text-destructive-ink">
                            {formErrors.street}
                          </p>
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        <div data-error={!!formErrors.building}>
                          <Input
                            label={t('Building no. *', 'رقم المبنى *')}
                            value={formData.building}
                            onChange={e => updateField('building', e.target.value)}
                            aria-invalid={formErrors.building ? true : undefined}
                            className={
                              formErrors.building
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : ''
                            }
                          />
                          {formErrors.building && (
                            <p role="alert" className="mt-1 text-sm text-destructive-ink">
                              {formErrors.building}
                            </p>
                          )}
                        </div>
                        <Input
                          label={t('Floor (optional)', 'الدور (اختياري)')}
                          value={formData.floor}
                          onChange={e => updateField('floor', e.target.value)}
                        />
                        <Input
                          label={t('Apartment (optional)', 'الشقة (اختياري)')}
                          autoComplete="address-line2"
                          value={formData.apartment}
                          onChange={e => updateField('apartment', e.target.value)}
                        />
                      </div>

                      <Input
                        label={t('Landmark (optional)', 'علامة مميزة (اختياري)')}
                        value={formData.landmark}
                        onChange={e => updateField('landmark', e.target.value)}
                      />

                      <div>
                        <label
                          htmlFor="order-notes"
                          className="block text-sm font-medium text-foreground mb-1"
                        >
                          {t(
                            'Order Notes (optional)',
                            '\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u0644\u0637\u0644\u0628 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                          )}
                        </label>
                        <textarea
                          id="order-notes"
                          value={formData.notes}
                          onChange={e => updateField('notes', e.target.value)}
                          rows={3}
                          // text-base on mobile prevents iOS Safari from
                          // auto-zooming when this textarea receives focus
                          // (any field <16px triggers it, won't auto-unzoom).
                          // sm:text-sm restores the denser desktop appearance.
                          className="min-h-24 w-full rounded-lg border border-border bg-background px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                          placeholder={t(
                            'Any special delivery instructions...',
                            '\u0623\u064a \u062a\u0639\u0644\u064a\u0645\u0627\u062a \u062e\u0627\u0635\u0629 \u0644\u0644\u062a\u0648\u0635\u064a\u0644...'
                          )}
                        />
                      </div>
                    </div>

                    {/* Save my info \u2014 device-local localStorage persistence.
                        NO payment data stored. Store-scoped key. */}
                    <div className="pt-3 border-t border-border">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={saveInfo}
                          onChange={e => setSaveInfo(e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary accent-primary focus:ring-2 focus:ring-primary/20"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                            {t(
                              'Save my info to speed up checkout next time',
                              '\u0627\u062d\u0641\u0638 \u0628\u064a\u0627\u0646\u0627\u062a\u064a \u0644\u062a\u0633\u0631\u064a\u0639 \u0627\u0644\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0645\u0631\u0629 \u0627\u0644\u0642\u0627\u062f\u0645\u0629'
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t(
                              'Your info is stored securely on this device. You can delete it anytime.',
                              '\u0633\u064a\u062a\u0645 \u062a\u062e\u0632\u064a\u0646 \u0645\u0639\u0644\u0648\u0645\u0627\u062a\u0643 \u0628\u0623\u0645\u0627\u0646 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062c\u0647\u0627\u0632. \u064a\u0645\u0643\u0646\u0643 \u062d\u0630\u0641\u0647\u0627 \u0641\u064a \u0623\u064a \u0648\u0642\u062a.'
                            )}
                          </span>
                        </span>
                      </label>
                      {saveInfo && (
                        <button
                          type="button"
                          onClick={handleClearSavedData}
                          className="mt-2 ms-7 text-xs text-destructive-ink hover:underline"
                        >
                          {t(
                            'Clear saved data',
                            '\u062d\u0630\u0641 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
                          )}
                        </button>
                      )}
                    </div>

                    {/* Below-minimum notice (desktop) */}
                    {belowMinimumOrder && minimumOrderMessage && (
                      <p
                        role="alert"
                        className="hidden lg:block mt-4 rounded-lg bg-warning/10 px-3 py-2 text-sm font-medium text-warning-ink"
                      >
                        {minimumOrderMessage}
                      </p>
                    )}

                    {/* Desktop-only button row \u2014 on mobile the button renders
                        AFTER <OrderSummary> so the order is:
                        address \u2192 discount/summary \u2192 Continue to Payment.
                        Hidden below lg; shown as a normal row on lg+. */}
                    <div className="hidden lg:flex mt-6 flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <Link
                        href={storeUrl('/cart')}
                        className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
                      >
                        {language === 'ar'
                          ? '\u0627\u0644\u0639\u0648\u062f\u0629 \u0625\u0644\u0649 \u0627\u0644\u0633\u0644\u0629 \u2192'
                          : '\u2190 Return to cart'}
                      </Link>
                      <Button
                        type="submit"
                        className="w-full sm:w-auto"
                        size="lg"
                        disabled={shippingUnavailable || belowMinimumOrder || !shippingSettled}
                      >
                        {t(
                          'Continue to Payment',
                          '\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0644\u0644\u062f\u0641\u0639'
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <PaymentStep
                    formData={formData}
                    onEditShipping={() => setStep(1)}
                    paymentProviders={paymentProviders}
                    paymentConfigError={paymentConfigError}
                    onRetryPaymentConfig={() => setCheckoutReloadKey(k => k + 1)}
                    selectedProvider={selectedProvider}
                    onSelectProvider={setSelectedProvider}
                    isProcessing={isProcessing || repricingShipping || shippingQuotePending}
                    total={total}
                    formatPrice={formatPrice}
                    belowMinimumOrder={belowMinimumOrder}
                    isDemo={store.isDemo === true}
                    deliverySection={
                      checkoutDelivery ? (
                        <div data-error={!!deliveryWindowError}>
                          <DeliverySection
                            settings={checkoutDelivery}
                            selection={deliverySelection}
                            selectedWindowId={selectedDeliveryWindowId}
                            onSelectWindow={id => {
                              setSelectedDeliveryWindowId(id);
                              setSelectedDeliveryDay(deliverySelection.day);
                              setDeliveryWindowError(null);
                            }}
                            error={deliveryWindowError}
                          />
                        </div>
                      ) : undefined
                    }
                  />
                )}
              </form>
            </div>

            {/* Order Summary */}
            <OrderSummary
              items={cart.items}
              bundles={cart.bundles}
              subtotal={subtotal}
              discount={discount}
              promotionDiscount={promotionAppliedDiscount}
              shipping={shipping}
              codFee={codFee}
              tax={tax}
              taxRatePercent={taxRatePercent}
              taxIncludedInPrice={taxIncludedInPrice}
              total={total}
              freeShipping={freeShipping}
              couponCode={couponCode}
              onCouponCodeChange={setCouponCode}
              appliedCoupon={appliedCoupon}
              onApplyCoupon={handleApplyCoupon}
              onRemoveCoupon={removeCoupon}
              couponError={couponError}
              loyalty={
                loyalty
                  ? {
                      points: loyalty.points,
                      pointsValue: loyalty.pointsValue,
                      minRedeemPoints: loyalty.minRedeemPoints,
                      enabled: redeemEnabled,
                      onToggle: setRedeemEnabled,
                      pointsToRedeem,
                      onPointsChange: setPointsToRedeem,
                      loyaltyDiscount,
                    }
                  : undefined
              }
              wallet={
                walletSpendable && wallet
                  ? {
                      balance: wallet.balance,
                      enabled: useWalletBalance,
                      onToggle: setUseWalletBalance,
                      applied: walletApplied,
                    }
                  : undefined
              }
              typography={checkoutTypography}
              summaryColors={checkoutSummaryColors}
            />

            {/* Mobile-only button row — visible only below lg breakpoint, after
                the OrderSummary (coupon + totals), so the mobile reading order
                is: address fields → discount/summary → Continue to Payment.
                Uses form="checkout-shipping-form" to submit the shipping form
                even though this button lives outside the <form> element.
                Hidden on lg+ because the desktop button row inside the form
                is visible there. Only rendered on shipping step (step === 1). */}
            {step === 1 && belowMinimumOrder && minimumOrderMessage && (
              <p
                role="alert"
                className="order-2 lg:hidden mt-4 rounded-lg bg-warning/10 px-3 py-2 text-sm font-medium text-warning-ink"
              >
                {minimumOrderMessage}
              </p>
            )}
            {step === 1 && (
              <div className="order-3 lg:hidden mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <Link
                  href={storeUrl('/cart')}
                  className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
                >
                  {language === 'ar' ? 'العودة إلى السلة →' : '← Return to cart'}
                </Link>
                <Button
                  type="submit"
                  form="checkout-shipping-form"
                  className="w-full sm:w-auto"
                  size="lg"
                  disabled={shippingUnavailable || belowMinimumOrder || !shippingSettled}
                >
                  {t('Continue to Payment', 'المتابعة للدفع')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
