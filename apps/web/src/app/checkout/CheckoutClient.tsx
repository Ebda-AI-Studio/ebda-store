'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Select } from '@force/ui';
import { MinimalChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { trackInitiateCheckout } from '../../components/MarketingPixels';
import { isValidEmail } from '@force/shared';
import { pageSurfaceStyle } from '@/lib/page-surface';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { OrderSummary } from './OrderSummary';

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

const KUWAIT_AREAS = [
  { en: 'Capital', ar: '\u0627\u0644\u0639\u0627\u0635\u0645\u0629' },
  { en: 'Hawalli', ar: '\u062d\u0648\u0644\u064a' },
  { en: 'Farwaniya', ar: '\u0627\u0644\u0641\u0631\u0648\u0627\u0646\u064a\u0629' },
  {
    en: 'Mubarak Al-Kabeer',
    ar: '\u0645\u0628\u0627\u0631\u0643 \u0627\u0644\u0643\u0628\u064a\u0631',
  },
  { en: 'Ahmadi', ar: '\u0627\u0644\u0623\u062d\u0645\u062f\u064a' },
  { en: 'Jahra', ar: '\u0627\u0644\u062c\u0647\u0631\u0627\u0621' },
];

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
  // Optional override for the minimal-chrome label on /checkout. Store
  // owners can rename or clear the "Secure Checkout" text via
  // store.settings.checkoutLabel / .checkoutLabelAr without code changes.
  const checkoutLabelEn =
    (store?.settings?.checkoutLabel as string | undefined) ?? 'Secure Checkout';
  const checkoutLabelAr = (store?.settings?.checkoutLabelAr as string | undefined) ?? 'دفع آمن';
  const storeUrl = useStoreUrl();
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

  // Shipping & discount
  const [selectedArea, setSelectedArea] = useState('');
  const [shippingCost, setShippingCost] = useState(0);
  const [freeShipping, setFreeShipping] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponError, setCouponError] = useState('');

  // Payment
  const [selectedProvider, setSelectedProvider] = useState('');

  // Form data — persisted in sessionStorage so a page refresh mid-checkout
  // doesn't wipe what the customer already typed.
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    address: '',
    apartment: '',
    area: '',
    notes: '',
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

  // Form validation errors
  const [formErrors, setFormErrors] = useState<{
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    area?: string;
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

    try {
      const result = await api.post<{ shippingCost: number; freeShipping: boolean }>(
        `/stores/public/${store.id}/shipping/calculate`,
        { area: selectedArea, orderTotal: cart.subtotal }
      );
      if (result.success && result.data) {
        setShippingCost(result.data.shippingCost || 0);
        setFreeShipping(result.data.freeShipping || false);
      }
    } catch (error) {
      console.error('Failed to calculate shipping:', error);
    }
  }, [selectedArea, store?.id, cart?.subtotal]);

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

    // Area validation
    if (!formData.area) {
      errors.area = t('Please select a delivery area', 'يرجى اختيار منطقة التوصيل');
    }

    // Address validation
    if (!formData.address.trim()) {
      errors.address = t('Block & Street address is required', 'عنوان القطعة والشارع مطلوب');
    } else if (formData.address.trim().length < 5) {
      errors.address = t('Please enter a complete address', 'يرجى إدخال عنوان كامل');
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

  // Calculate totals
  const subtotal = cart?.subtotal || 0;
  const discount = couponDiscount;
  const shipping = freeShipping ? 0 : shippingCost;
  const total = subtotal - discount + shipping;

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
      setStep(2);
      return;
    }

    setIsProcessing(true);
    setCheckoutError(null);

    try {
      // Create order. Include the form's email on the shipping address so
      // the invoice / order confirmation can show the *buyer's* contact email
      // — not the authenticated user's profile email (which can differ when
      // a logged-in admin checks out for someone else).
      const orderResult = await api.createOrder({
        shippingAddress: {
          firstName: formData.firstName,
          lastName: formData.lastName,
          address1: formData.address,
          address2: formData.apartment,
          city: '',
          state: formData.area,
          postalCode: '',
          country: 'KW',
          phone: formData.phone,
          email: formData.email,
        },
        paymentMethod: selectedProvider,
        notes: formData.notes,
        couponCode: appliedCoupon?.code,
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
          <Link href={storeUrl('/products')}>
            <Button className="mt-6">
              {t('Continue Shopping', translations['Continue Shopping'])}
            </Button>
          </Link>
        </div>
      </MinimalChrome>
    );
  }

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
                className={`flex items-center ${step > 1 ? 'cursor-pointer group' : 'cursor-default'}`}
              >
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${step >= 1 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'} ${step > 1 ? 'group-hover:bg-primary/80' : ''}`}
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
                  className={`ml-2 text-sm font-medium transition-colors ${step >= 1 ? 'text-foreground' : 'text-muted-foreground'} ${step > 1 ? 'group-hover:text-primary' : ''}`}
                >
                  {t('Shipping', translations['Shipping'])}
                </span>
              </button>
              <div className={`mx-4 h-0.5 w-16 ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
              {/* Step 2: Payment -- current or future step, not clickable */}
              <div className="flex items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 2 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}
                >
                  2
                </div>
                <span
                  className={`ml-2 text-sm font-medium ${step >= 2 ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {t('Payment', '\u0627\u0644\u062f\u0641\u0639')}
                </span>
              </div>
            </div>
          </div>

          <div className="lg:grid lg:grid-cols-12 lg:gap-8">
            {/* Form */}
            <div className="lg:col-span-8">
              <form onSubmit={handleSubmit}>
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

                      <div data-error={!!formErrors.area}>
                        <Select
                          label={t(
                            'Delivery Area',
                            '\u0645\u0646\u0637\u0642\u0629 \u0627\u0644\u062a\u0648\u0635\u064a\u0644'
                          )}
                          value={formData.area}
                          onChange={e => updateField('area', e.target.value)}
                          aria-invalid={formErrors.area ? true : undefined}
                          options={[
                            {
                              value: '',
                              label: t(
                                'Select area...',
                                '\u0627\u062e\u062a\u0631 \u0627\u0644\u0645\u0646\u0637\u0642\u0629...'
                              ),
                            },
                            ...KUWAIT_AREAS.map(a => ({
                              value: a.en,
                              label: language === 'ar' ? `${a.ar} / ${a.en}` : `${a.en} / ${a.ar}`,
                            })),
                          ]}
                          className={
                            formErrors.area
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.area && (
                          <p role="alert" className="mt-1 text-sm text-destructive">
                            {formErrors.area}
                          </p>
                        )}
                      </div>

                      <div data-error={!!formErrors.address}>
                        <Input
                          label={t(
                            'Block & Street',
                            '\u0627\u0644\u0642\u0637\u0639\u0629 \u0648\u0627\u0644\u0634\u0627\u0631\u0639'
                          )}
                          autoComplete="street-address"
                          value={formData.address}
                          onChange={e => updateField('address', e.target.value)}
                          aria-invalid={formErrors.address ? true : undefined}
                          className={
                            formErrors.address
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.address && (
                          <p role="alert" className="mt-1 text-sm text-destructive">
                            {formErrors.address}
                          </p>
                        )}
                      </div>

                      <Input
                        label={t(
                          'Building / House / Apartment',
                          '\u0627\u0644\u0645\u0628\u0646\u0649 / \u0627\u0644\u0645\u0646\u0632\u0644 / \u0627\u0644\u0634\u0642\u0629'
                        )}
                        autoComplete="address-line2"
                        value={formData.apartment}
                        onChange={e => updateField('apartment', e.target.value)}
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

                    <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <Link
                        href={storeUrl('/cart')}
                        className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
                      >
                        {language === 'ar'
                          ? '\u0627\u0644\u0639\u0648\u062f\u0629 \u0625\u0644\u0649 \u0627\u0644\u0633\u0644\u0629 \u2192'
                          : '\u2190 Return to cart'}
                      </Link>
                      <Button type="submit" className="w-full sm:w-auto" size="lg">
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
              typography={checkoutTypography}
            />
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
