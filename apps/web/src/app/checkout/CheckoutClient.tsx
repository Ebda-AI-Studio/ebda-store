'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { trackInitiateCheckout } from '../../components/MarketingPixels';
import {
  isValidEmail,
  KUWAIT_GOVERNORATES,
  findGovernorateByArea,
  resolveColor,
} from '@force/shared';
import { GovernorateAreaSelect } from './_components/GovernorateAreaSelect';
import { saveCheckoutInfo, loadCheckoutInfo, clearCheckoutInfo } from './_lib/savedCheckout';
import { pageSurfaceStyle } from '@/lib/page-surface';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { OrderSummary } from './OrderSummary';
import { useLastListing } from '../../hooks/useLastListing';

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
import { formatPrice } from '@/lib/format';
import type { CheckoutCartItem, Coupon, PaymentProvider } from './types';

interface Cart {
  id: string;
  items: CheckoutCartItem[];
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
  const { items: cartContextItems, total: cartContextTotal, isReady: cartIsReady } = useCart();
  const { language, t } = useLanguage();
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Fire InitiateCheckout pixel event once the cart has hydrated from the
  // server and we know it isn't empty. Firing on mount (before hydration)
  // would miss the event because cartContextItems starts empty.
  const pixelFiredRef = useRef(false);
  useEffect(() => {
    if (pixelFiredRef.current) return;
    if (!cartIsReady || cartContextItems.length === 0) return;
    pixelFiredRef.current = true;
    trackInitiateCheckout({
      contentIds: cartContextItems.map(item => item.productId),
      numItems: cartContextItems.reduce((sum, item) => sum + item.quantity, 0),
      value: cartContextTotal / 1000,
      currency: 'KWD',
    });
  }, [cartIsReady, cartContextItems, cartContextTotal]);

  // CartContext is write-through to /public/cart, so the context is the
  // single source of truth for both display and order creation. Memoized so
  // hooks that depend on it don't re-run on unrelated re-renders.
  const cart: Cart | null = useMemo(() => {
    if (cartContextItems.length === 0) return null;
    return {
      id: 'cart',
      items: cartContextItems.map(item => ({
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
      subtotal: cartContextTotal,
      total: cartContextTotal,
    };
  }, [cartContextItems, cartContextTotal]);
  const [, setShippingZones] = useState<ShippingZone[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<PaymentProvider[]>([]);

  // Area-rate data fetched once on mount from the public endpoint
  const [ratedAreas, setRatedAreas] = useState<Set<string>>(new Set());
  const [ratedGovernorates, setRatedGovernorates] = useState<Set<string>>(new Set());
  const [rateByArea, setRateByArea] = useState<Map<string, AreaRate>>(new Map());
  // Full rates array — passed to GovernorateAreaSelect for custom-area support
  const [allAreaRates, setAllAreaRates] = useState<AreaRate[]>([]);
  const [shippingUnavailable, setShippingUnavailable] = useState(false);
  // Whether the store configured per-area shipping rates at all. When false,
  // the store has no shipping config → legacy free-shipping behavior (cost 0),
  // NOT "unavailable". A `matched:false` result only means "not available"
  // when the store DOES have area rates but this specific area isn't covered.
  const [storeHasAreaRates, setStoreHasAreaRates] = useState(false);

  // Shipping & discount
  const [selectedArea, setSelectedArea] = useState('');
  const [shippingCost, setShippingCost] = useState(0);
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
    pointsValue: number; // fils per point
    minRedeemPoints: number;
    maxRedeemPercentage: number;
  } | null>(null);
  const [redeemEnabled, setRedeemEnabled] = useState(false);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  // Payment
  const [selectedProvider, setSelectedProvider] = useState('');

  // Customer SMS marketing opt-in. Default false — never opt in silently.
  // Only affects promotional SMS (cart reminders, back-in-stock alerts).
  // Transactional notifications (order confirmed, shipped, etc.) are not
  // gated on this and send whenever the channel is configured.
  const [smsOptIn, setSmsOptIn] = useState(false);

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
    // Kuwaiti structured address fields
    governorate: '', // EN canonical (e.g. 'Hawalli')
    area: '', // EN canonical (e.g. 'Salmiya')
    block: '', // قطعة *
    street: '', // الشارع *
    avenue: '', // الجادة (optional)
    house: '', // منزل *
    floor: '', // الطابق (optional)
    apartment: '', // شقة (optional)
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
  // under `fwb.wa-customer-phone` when a customer arrives via the WhatsApp
  // ordering flow. Pre-fill the shipping phone with that value when the form
  // is otherwise blank — never overwrite a value the customer already typed.
  // The marker is removed once consumed so a later session-storage hit can't
  // clobber a deliberate edit on a return visit.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (formData.phone.trim() !== '') return;
    let waPhone: string | null = null;
    try {
      waPhone = window.sessionStorage.getItem('fwb.wa-customer-phone');
    } catch {
      return;
    }
    if (!waPhone) return;
    const normalized = waPhone.trim();
    if (!normalized) return;
    setFormData(prev => (prev.phone.trim() === '' ? { ...prev, phone: normalized } : prev));
    try {
      window.sessionStorage.removeItem('fwb.wa-customer-phone');
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
      block: saved.block || prev.block,
      street: saved.street || prev.street,
      avenue: saved.avenue || prev.avenue,
      house: saved.house || prev.house,
      floor: saved.floor || prev.floor,
      apartment: saved.apartment || prev.apartment,
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
    block?: string;
    street?: string;
    house?: string;
    address?: string;
  }>({});

  // Checkout error state
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Fetch initial data (shipping zones and payment config)
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        // Fetch shipping zones and payment config in parallel
        const [shippingResult, paymentResult] = await Promise.all([
          store?.id
            ? api.get<{ zones: ShippingZone[] }>(`/stores/public/${store.id}/shipping`)
            : Promise.resolve(null),
          api.get<{
            providers: (PaymentProvider | string)[];
            defaultProvider?: string;
            cod?: { fixedFee: number; displayName: string; displayNameAr: string | null };
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
          // API returns providers as a string[] (e.g. ["myfatoorah"]) — normalize
          // each entry to the {id, name} object the PaymentStep map expects.
          // PaymentStep falls back to DEFAULT_PAYMENT_PROVIDERS for display info.
          const rawProviders = paymentResult.data.providers || [];
          const allProviders: PaymentProvider[] = rawProviders.map(p =>
            typeof p === 'string' ? { id: p, name: p } : p
          );

          // Add COD as a provider option if enabled
          if (paymentResult.data.cod) {
            const codFee = paymentResult.data.cod.fixedFee || 0;
            const feeText = codFee > 0 ? ` (+${formatPrice(codFee)})` : '';
            allProviders.push({
              id: 'cod',
              name: `${paymentResult.data.cod.displayName || 'Cash on Delivery'}${feeText}`,
              nameAr: paymentResult.data.cod.displayNameAr
                ? `${paymentResult.data.cod.displayNameAr}${feeText}`
                : undefined,
              description: 'Pay when your order is delivered',
              descriptionAr: 'ادفع عند استلام طلبك',
            });
          }

          setPaymentProviders(allProviders);
          if (paymentResult.data.defaultProvider) {
            setSelectedProvider(paymentResult.data.defaultProvider);
          }
        }
      } catch (error) {
        console.error('Failed to fetch checkout data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [store?.id]);

  // Calculate shipping when area changes
  const calculateShipping = useCallback(async () => {
    if (!selectedArea || !store?.id || !cart?.subtotal) return;

    setShippingUnavailable(false);
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
      }
    } catch (error) {
      console.error('Failed to calculate shipping:', error);
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

    // Phone validation (Kuwait format)
    if (!formData.phone.trim()) {
      errors.phone = t('Phone number is required', 'رقم الهاتف مطلوب');
    } else {
      // Remove spaces, dashes and plus sign for validation
      const cleanPhone = formData.phone.replace(/[\s\-+]/g, '');
      // Kuwait numbers: 965 + 8 digits OR 8 digits.
      // Mobile prefixes: 5/6/9. Landline prefixes: 2/4. All 8 digits total.
      if (!/^(965)?[24569]\d{7}$/.test(cleanPhone)) {
        errors.phone = t(
          'Please enter a valid Kuwait phone number',
          'يرجى إدخال رقم هاتف كويتي صحيح'
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

    // Block validation (required)
    if (!formData.block.trim()) {
      errors.block = t('Block is required', 'القطعة مطلوبة');
    }

    // Street validation (required)
    if (!formData.street.trim()) {
      errors.street = t('Street is required', 'الشارع مطلوب');
    }

    // House validation (required)
    if (!formData.house.trim()) {
      errors.house = t('House / building number is required', 'رقم المنزل أو المبنى مطلوب');
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
          { code, orderTotal: cart.subtotal }
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
          setCouponError(result.error?.message || t('Invalid coupon', 'كوبون غير صالح'));
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
    [couponCode, store?.id, cart, promoStorageKey, t]
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
      block: '',
      street: '',
      avenue: '',
      house: '',
      floor: '',
      apartment: '',
      notes: '',
    }));
    setSelectedArea('');
  };

  const removeCoupon = () => {
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
    calculateShipping();
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
          // maxRedeemPercentage isn't exposed publicly; the server enforces
          // it authoritatively. Use 100 here so the UI estimate never blocks a
          // valid redemption — the server caps the real discount.
          maxRedeemPercentage: 100,
        });
      } catch {
        if (!cancelled) setLoyalty(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, store?.id]);

  // Calculate totals
  const subtotal = cart?.subtotal || 0;

  // Loyalty discount estimate. Mirrors the server's computeRedemption so the
  // order summary matches what the API will actually apply: clamp points to
  // balance, gate at the minimum, cap the discount at the goods value
  // remaining after the coupon. The server re-validates; this is display-only.
  const redeemableAfterCoupon = Math.max(0, subtotal - couponDiscount);
  const effectiveRedeemPoints =
    redeemEnabled && loyalty
      ? Math.min(Math.max(0, Math.floor(pointsToRedeem)), loyalty.points)
      : 0;
  const loyaltyDiscount =
    loyalty && effectiveRedeemPoints >= loyalty.minRedeemPoints && effectiveRedeemPoints > 0
      ? Math.min(effectiveRedeemPoints * loyalty.pointsValue, redeemableAfterCoupon)
      : 0;
  // The point count we actually send: when the subtotal cap binds, reduce
  // points so we never request to burn more than the discount represents.
  const pointsToSend =
    loyalty && loyaltyDiscount > 0
      ? Math.min(effectiveRedeemPoints, Math.floor(loyaltyDiscount / loyalty.pointsValue))
      : 0;

  const discount = couponDiscount + loyaltyDiscount;
  const shipping = freeShipping ? 0 : shippingCost;
  const total = Math.max(0, subtotal - discount + shipping);

  // Submit order
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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

    setIsProcessing(true);
    setCheckoutError(null);

    // Persist or clear saved info based on the saveInfo checkbox.
    if (store?.id) {
      const selectedGovForSave = KUWAIT_GOVERNORATES.find(g => g.en === formData.governorate);
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
          block: formData.block,
          street: formData.street,
          avenue: formData.avenue,
          house: formData.house,
          floor: formData.floor,
          apartment: formData.apartment,
          notes: formData.notes,
        });
      } else {
        clearCheckoutInfo(store.id);
      }
    }

    try {
      // Create order. Include the form's email on the shipping address so
      // the invoice / order confirmation can show the *buyer's* contact email
      // — not the authenticated user's profile email (which can differ when
      // a logged-in admin checks out for someone else).
      // Resolve both English and Arabic names.
      // For Kuwait areas, prefer the static canonical data; for custom areas
      // (not in the static list), fall back to the rate-row AR names.
      const selectedGov = KUWAIT_GOVERNORATES.find(g => g.en === formData.governorate);
      const selectedKuwaitArea =
        selectedGov?.areas.find(a => a.en === formData.area) ??
        findGovernorateByArea(formData.area)?.areas.find(a => a.en === formData.area);
      const rateRow = rateByArea.get(formData.area);

      // Compose address1 from structured fields for back-compat with
      // existing order display / admin views.
      const address1Parts = [
        formData.block ? `Block ${formData.block}` : '',
        formData.street ? `Street ${formData.street}` : '',
        formData.avenue ? `Avenue ${formData.avenue}` : '',
        formData.house ? `House ${formData.house}` : '',
      ].filter(Boolean);
      const composedAddress1 = address1Parts.join(', ') || formData.address;

      const orderResult = await api.createOrder({
        shippingAddress: {
          firstName: formData.firstName,
          lastName: formData.lastName,
          address1: composedAddress1,
          address2: formData.apartment,
          // Structured address fields — custom area AR names fall back to the rate row.
          area: selectedKuwaitArea?.en ?? formData.area,
          areaAr: selectedKuwaitArea?.ar ?? rateRow?.areaAr ?? '',
          governorate: selectedGov?.en ?? formData.governorate,
          governorateAr: selectedGov?.ar ?? rateRow?.governorateAr ?? '',
          // Additional structured fields for delivery logistics
          block: formData.block,
          street: formData.street,
          avenue: formData.avenue,
          house: formData.house,
          floor: formData.floor,
          city: '',
          // Use the country from the rate row when available (multi-country stores),
          // falling back to "Kuwait" — matches the Address.country default + the
          // "Kuwait" value every Kuwait rate row carries (don't mix "KW" / "Kuwait").
          country: rateRow?.country ?? 'Kuwait',
          phone: formData.phone,
          email: formData.email,
        },
        paymentMethod: selectedProvider,
        notes: formData.notes,
        couponCode: appliedCoupon?.code,
        smsOptIn,
        // Only send a redemption request when the customer opted in AND the
        // amount clears the store minimum. The server re-validates against the
        // real balance + caps regardless.
        pointsToRedeem: pointsToSend > 0 ? pointsToSend : undefined,
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

      // Create payment.
      // Send RELATIVE paths so the api can absolutify them against the order's
      // resolved storefront base url (custom domain or slug). Sending absolute
      // urls with the store's custom domain trips the schema's platform-origin
      // refinement, which is intended to block open-redirect attacks.
      const paymentResult = await api.post<{ paymentUrl?: string; cod?: boolean }>(
        '/payments/create',
        {
          orderId: order.id,
          provider: selectedProvider,
          successUrl: `/checkout/success?orderId=${order.id}`,
          errorUrl: `/checkout/error?orderId=${order.id}`,
        }
      );

      // Order created -- clear the saved checkout form and promo code
      // before leaving the page so they don't leak into the next order.
      if (typeof window !== 'undefined') {
        try {
          if (checkoutStorageKey) window.sessionStorage.removeItem(checkoutStorageKey);
          if (promoStorageKey) window.sessionStorage.removeItem(promoStorageKey);
        } catch {
          // Non-fatal
        }
      }

      if (paymentResult.success && paymentResult.data?.cod) {
        // Cash on delivery — go straight to success
        router.push(storeUrl(`/checkout/success?orderId=${order.id}&cod=1`));
      } else if (paymentResult.success && paymentResult.data?.paymentUrl) {
        // Online payment — redirect to payment gateway
        window.location.href = paymentResult.data.paymentUrl;
      } else {
        // Throw an Error so the catch block runs the customer-friendly mapping.
        // We pass the API error code (not message) so the catch can decide.
        const err = new Error(paymentResult.error?.code || 'PAYMENT_FAILED');
        // Attach the raw message for the dev console only.
        (err as Error & { rawMessage?: string }).rawMessage = paymentResult.error?.message || '';
        throw err;
      }
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
          'shippingAddress.block': 'block',
          'shippingAddress.street': 'street',
          'shippingAddress.house': 'house',
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

      let friendly: string;
      switch (code) {
        case 'COD_NOT_AVAILABLE':
          friendly = t(
            'Cash on delivery is currently unavailable. Please choose another payment method.',
            'الدفع عند الاستلام غير متاح حالياً. يرجى اختيار طريقة دفع أخرى.'
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
        case 'COUPON_LIMIT_REACHED':
          friendly = t(
            'The coupon you applied has reached its usage limit. Please remove it and try again.',
            'تم استخدام الكوبون الذي طبّقته بالكامل. يرجى إزالته والمحاولة مرة أخرى.'
          );
          break;
        case 'MIN_ORDER_NOT_MET':
          friendly = t(
            'Your order does not meet the minimum amount required for this coupon.',
            'طلبك لا يستوفي الحد الأدنى للمبلغ المطلوب لهذا الكوبون.'
          );
          break;
        case 'INSUFFICIENT_INVENTORY':
          friendly = t(
            'One of the items in your cart is out of stock. Please review your cart.',
            'أحد المنتجات في سلتك غير متوفر. يرجى مراجعة سلة التسوق.'
          );
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

  if (!cart || cart.items.length === 0) {
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
    allAreaRates.length > 0 ? [...new Set(allAreaRates.map(r => r.country))] : ['Kuwait'];
  const isSingleCountryStore = distinctRatedCountries.length <= 1;
  const singleCountryEn = distinctRatedCountries[0] ?? 'Kuwait';
  const singleCountryAr =
    allAreaRates.find(r => r.country === singleCountryEn)?.countryAr ?? 'الكويت';

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
                            <p role="alert" className="mt-1 text-sm text-destructive">
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
                            <p role="alert" className="mt-1 text-sm text-destructive">
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
                          placeholder="+965 XXXX XXXX"
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
                          <p role="alert" className="mt-1 text-sm text-destructive">
                            {formErrors.phone}
                          </p>
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
                          <p role="alert" className="mt-1 text-sm text-destructive">
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
                          <p className="text-sm text-destructive">
                            {t(
                              'Not available for delivery to this area',
                              '\u063a\u064a\u0631 \u0645\u062a\u0627\u062d \u0644\u0644\u062a\u0648\u0635\u064a\u0644 \u0644\u0647\u0630\u0647 \u0627\u0644\u0645\u0646\u0637\u0642\u0629'
                            )}
                          </p>
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

                      {/* Structured Kuwaiti address fields */}
                      <div className="grid grid-cols-2 gap-4">
                        <div data-error={!!formErrors.block}>
                          <Input
                            label={t('Block *', '\u0642\u0637\u0639\u0629 *')}
                            value={formData.block}
                            onChange={e => updateField('block', e.target.value)}
                            aria-invalid={formErrors.block ? true : undefined}
                            className={
                              formErrors.block
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : ''
                            }
                          />
                          {formErrors.block && (
                            <p role="alert" className="mt-1 text-sm text-destructive">
                              {formErrors.block}
                            </p>
                          )}
                        </div>
                        <div data-error={!!formErrors.street}>
                          <Input
                            label={t('Street *', '\u0627\u0644\u0634\u0627\u0631\u0639 *')}
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
                            <p role="alert" className="mt-1 text-sm text-destructive">
                              {formErrors.street}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label={t(
                            'Avenue (optional)',
                            '\u0627\u0644\u062c\u0627\u062f\u0629 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                          )}
                          value={formData.avenue}
                          onChange={e => updateField('avenue', e.target.value)}
                        />
                        <div data-error={!!formErrors.house}>
                          <Input
                            label={t(
                              'House / Building *',
                              '\u0645\u0646\u0632\u0644 / \u0645\u0628\u0646\u0649 *'
                            )}
                            value={formData.house}
                            onChange={e => updateField('house', e.target.value)}
                            aria-invalid={formErrors.house ? true : undefined}
                            className={
                              formErrors.house
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : ''
                            }
                          />
                          {formErrors.house && (
                            <p role="alert" className="mt-1 text-sm text-destructive">
                              {formErrors.house}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label={t(
                            'Floor (optional)',
                            '\u0627\u0644\u0637\u0627\u0628\u0642 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                          )}
                          value={formData.floor}
                          onChange={e => updateField('floor', e.target.value)}
                        />
                        <Input
                          label={t(
                            'Apartment (optional)',
                            '\u0634\u0642\u0629 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                          )}
                          autoComplete="address-line2"
                          value={formData.apartment}
                          onChange={e => updateField('apartment', e.target.value)}
                        />
                      </div>

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

                    {/* SMS marketing opt-in \u2014 shown only when the phone field
                        has a value so the checkbox is contextually relevant. */}
                    {formData.phone.trim() && (
                      <div className="pt-2">
                        <label className="flex items-start gap-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={smsOptIn}
                            onChange={e => setSmsOptIn(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary accent-primary focus:ring-2 focus:ring-primary/20"
                          />
                          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                            {t(
                              'I agree to receive promotional SMS messages (offers, alerts). You can unsubscribe at any time.',
                              '\u0623\u0648\u0627\u0641\u0642 \u0639\u0644\u0649 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0631\u0633\u0627\u0626\u0644 SMS \u062a\u0631\u0648\u064a\u062c\u064a\u0629 (\u0639\u0631\u0648\u0636\u060c \u062a\u0646\u0628\u064a\u0647\u0627\u062a). \u064a\u0645\u0643\u0646\u0643 \u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643 \u0641\u064a \u0623\u064a \u0648\u0642\u062a.'
                            )}
                          </span>
                        </label>
                      </div>
                    )}

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
                          className="mt-2 ms-7 text-xs text-destructive hover:underline"
                        >
                          {t(
                            'Clear saved data',
                            '\u062d\u0630\u0641 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
                          )}
                        </button>
                      )}
                    </div>

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
                        disabled={shippingUnavailable}
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
                    checkoutError={checkoutError}
                    onClearError={() => setCheckoutError(null)}
                    formData={formData}
                    onEditShipping={() => setStep(1)}
                    paymentProviders={paymentProviders}
                    selectedProvider={selectedProvider}
                    onSelectProvider={setSelectedProvider}
                    isProcessing={isProcessing}
                    total={total}
                    formatPrice={formatPrice}
                  />
                )}
              </form>
            </div>

            {/* Order Summary */}
            <OrderSummary
              items={cart.items}
              subtotal={subtotal}
              discount={discount}
              shipping={shipping}
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
            {step === 1 && (
              <div className="lg:hidden mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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
                  disabled={shippingUnavailable}
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
