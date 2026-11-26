'use client';

import { createContext, useContext, useState, useEffect, useLayoutEffect, ReactNode } from 'react';
import { BRAND } from '@ebda/shared';

import { resolveDefaultLanguage } from '@ebda/shared';
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Language = 'en' | 'ar';
type Direction = 'ltr' | 'rtl';

interface LanguageContextType {
  language: Language;
  direction: Direction;
  /** Shorthand for `language === 'ar'`. Every template/component that used
   *  to accept an `isRtl?: boolean` prop should read this instead so the
   *  prop can eventually disappear from the template contract. */
  isRtl: boolean;
  setLanguage: (lang: Language) => void;
  t: (en: string, ar: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// Resolution: storeDefault (already cookie-aware from layout.tsx SSR) is
// preferred so the server-render and the first client render agree (no
// hydration mismatch). localStorage is the fallback for the cookie-lost
// edge case (private windows that cleared cookies).
function getInitialLanguage(storeDefault?: Language): Language {
  if (typeof window === 'undefined') return storeDefault || resolveDefaultLanguage(undefined);
  if (storeDefault === 'en' || storeDefault === 'ar') return storeDefault;
  const savedLang = localStorage.getItem('force-language') as Language;
  if (savedLang && ['en', 'ar'].includes(savedLang)) {
    return savedLang;
  }
  return resolveDefaultLanguage(undefined);
}

/** `/ar/products` -> `/en/products`; null when the path carries no language prefix (or already has `lang`). */
export function swapLocalePrefix(pathname: string, lang: Language): string | null {
  const m = /^\/(ar|en)(\/.*)?$/.exec(pathname);
  if (!m || m[1] === lang) return null;
  return `/${lang}${m[2] ?? ''}`;
}

// Cookie helpers — used so the user's locale choice survives full page
// reloads + propagates to server-rendered chrome (titles, breadcrumbs,
// schema.org). The cookie is read in `apps/web/src/app/layout.tsx`.
function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  // 1 year, path=/, SameSite=Lax so the value persists across navigation
  // (incl. cross-store-domain redirects from the platform).
  // Secure only on https so Safari localhost dev (not a trustworthy origin
  // for Secure cookies) keeps working. ZAP 10011.
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax${secure}`;
}

interface LanguageProviderProps {
  children: ReactNode;
  defaultLanguage?: Language;
}

export function LanguageProvider({ children, defaultLanguage }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>(() =>
    getInitialLanguage(defaultLanguage)
  );
  const direction: Direction = language === 'ar' ? 'rtl' : 'ltr';

  // Use useLayoutEffect to avoid flash - sync document attributes (falls back to useEffect on server)
  useIsomorphicLayoutEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = language;
    // A look store's body face comes from `[data-look]` in globals.css (--font-body); an inline
    // font-family here would beat that rule, so a look store gets none (legacy stores unchanged).
    document.body.style.fontFamily = document.body.hasAttribute('data-look')
      ? ''
      : language === 'ar'
        ? 'var(--font-arabic), var(--font-sans), sans-serif'
        : 'var(--font-sans), sans-serif';
    localStorage.setItem('force-language', language);
    writeCookie('force-language', language);
  }, [language, direction]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    // Reload so the next SSR pass uses the new cookie + re-renders server
    // chrome (titles, breadcrumbs, meta, schema.org) in the chosen locale.
    // Without this the user keeps the AR/EN-rendered HTML they already
    // have until they navigate away.
    if (typeof window !== 'undefined') {
      writeCookie('force-language', lang);
      // Language in the URL (LOCALE-PATHS-1): on a `/ar|/en` page the other language is another URL, so go there
      // instead of reloading the same one (the middleware would keep the URL's language and ignore the cookie).
      const target = swapLocalePrefix(window.location.pathname, lang);
      // Defer the navigation so the cookie write commits first
      // (some browsers flush cookies on next event loop tick).
      setTimeout(
        () =>
          target
            ? window.location.assign(target + window.location.search + window.location.hash)
            : window.location.reload(),
        0
      );
    }
  };

  // Simple translation helper - returns Arabic or English text
  const t = (en: string, ar: string) => {
    return language === 'ar' ? ar : en;
  };

  return (
    <LanguageContext.Provider
      value={{ language, direction, isRtl: language === 'ar', setLanguage, t }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}

// Common translations for the storefront
export const translations = {
  // Header
  Products: 'المنتجات',
  Categories: 'الفئات',
  About: 'من نحن',
  Contact: 'اتصل بنا',
  'Search products...': 'البحث عن المنتجات...',
  // Souq search-first header (Phase B2): the field's label / placeholder and its clear button.
  'Search for a product or brand': 'دوّر على منتج أو ماركة',
  'Clear search': 'مسح البحث',
  'Sign In': 'تسجيل الدخول',
  Cart: 'السلة',
  Wishlist: 'المفضلة',

  // Home Page
  'Shop Now': 'تسوق الآن',
  'View All': 'عرض الكل',
  'Featured Products': 'منتجات مميزة',
  'New Arrivals': 'وصل حديثاً',
  'Best Sellers': 'الأكثر مبيعاً',
  'On Sale': 'تخفيضات',

  // Product
  'Add to Cart': 'أضف إلى السلة',
  'Buy Now': 'اشتري الآن',
  'In Stock': 'متوفر',
  'Out of Stock': 'غير متوفر',
  Description: 'الوصف',
  Reviews: 'التقييمات',

  // Cart
  'Added to cart': 'اتضاف للسلة',
  'View cart': 'عرض السلة',
  'Shopping Cart': 'سلة التسوق',
  'Your cart is empty': 'سلة التسوق فاضية',
  'Continue Shopping': 'متابعة التسوق',
  Subtotal: 'المجموع الفرعي',
  Shipping: 'الشحن',
  Free: 'مجاني',
  Total: 'الإجمالي',
  'Proceed to Checkout': 'المتابعة للدفع',
  'Order Summary': 'ملخص الطلب',
  'Promo Code': 'كود الخصم',
  Apply: 'تطبيق',
  // Automatic-promotion discount line at checkout — distinct from the
  // generic "Discount" label used for coupon-code discounts.
  Promotion: 'عرض ترويجي',
  // Shown on the cart + checkout order summary ONLY when the cart holds a
  // bundle AND a coupon is applied. A bundle's price is already discounted,
  // so a coupon is deliberately evaluated against the loose items only — the
  // customer otherwise sees a discount much smaller than the coupon's
  // headline percentage with no explanation.
  'Coupon applies to items outside your bundles — a bundle is already discounted.':
    'الكوبون بيتطبق على المنتجات اللي برّه الباقات بس — سعر الباقة مخفّض أصلاً.',

  // Checkout
  Checkout: 'الدفع',
  'Shipping Address': 'عنوان الشحن',
  'Payment Method': 'طريقة الدفع',
  'Place Order': 'تأكيد الطلب',

  // Account
  'My Account': 'حسابي',
  'My Orders': 'طلباتي',
  Addresses: 'العناوين',
  Settings: 'الإعدادات',
  Logout: 'تسجيل الخروج',

  // Footer
  Shop: 'تسوق',
  Support: 'الدعم',
  Company: 'الشركة',
  FAQ: 'الأسئلة الشائعة',
  'Shipping Info': 'معلومات الشحن',
  'Returns & Refunds': 'المرتجعات واسترداد الأموال',
  'Privacy Policy': 'سياسة الخصوصية',
  'Terms of Service': 'الشروط والأحكام',
  'About Us': 'من نحن',
  Newsletter: 'النشرة البريدية',
  Email: 'البريد الإلكتروني',
  'We accept:': 'طرق الدفع المتاحة:',

  // Common
  Home: 'الرئيسية',
  'All Products': 'كل المنتجات',
  Filter: 'تصفية',
  Sort: 'ترتيب',
  Price: 'السعر',
  'Low to High': 'من الأقل للأعلى',
  'High to Low': 'من الأعلى للأقل',
  Search: 'بحث',
  // Search results sort: the hybrid relevance order (shown only when the server ranked the list).
  'Most relevant': 'الأكثر صلة',
  'No results found': 'ملقيناش نتايج',
  'Loading...': 'بنحمّل...',
  Error: 'خطأ',
  Success: 'تمام',
  EGP: 'ج.م',
  Retry: 'إعادة المحاولة',
  'Something went wrong': 'حدث خطأ ما',
  'Try Again': 'جرّب تاني',
  'Go Home': 'العودة للرئيسية',

  // Shipping
  'Free delivery on orders over 20 EGP': 'توصيل مجاني للطلبات فوق 20 ج.م',
  'Same-day delivery across Egypt': 'توصيل في نفس اليوم في كل مصر',

  // Auth
  Login: 'دخول',
  Register: 'تسجيل',
  'Create Account': 'إنشاء حساب',
  'Forgot Password?': 'نسيت كلمة المرور؟',
  Password: 'كلمة المرور',
  'Confirm Password': 'تأكيد كلمة المرور',
  'Full Name': 'الاسم الكامل',
  Phone: 'رقم الموبايل',

  // Locations page
  Locations: 'الفروع',
  'Our Locations': 'فروعنا',
  // Storefront footer "Branches" column heading (B3, 2026-09-25) — opt-in
  // per store via Branding → Locations → "Show branches in footer".
  Branches: 'فروعنا',
  'Visit a store — tap a branch for directions, to call, or to message us.':
    'زور فرع من فروعنا — دوس على الفرع للاتجاهات أو الاتصال أو المراسلة.',
  'Open in Maps': 'افتح في الخرائط',
  Call: 'اتصال',
  WhatsApp: 'واتساب',
  Address: 'العنوان',
  Hours: 'ساعات العمل',

  // Maintenance / suspended store branded page. Surfaced by
  // `StoreMaintenance` when the resolved store has `status === 'suspended'`.
  // Keep copy short — this is the merchant's last impression on a customer
  // when their store is offline, so the page must read as intentional rather
  // than broken.
  'This store is temporarily unavailable': 'المتجر غير متاح مؤقتًا',
  'is not taking orders right now. Please check back later.':
    'مش بيستقبل طلبات دلوقتي. جرّب تاني بعدين.',
  'Need to reach us?': 'تحتاج للتواصل معنا؟',
  'Powered by Ebda Store': `مدعوم من ${BRAND.product.nameAr}`,

  // Campaign unsubscribe page (/unsubscribe, D2 email campaigns).
  'Email preferences': 'تفضيلات البريد الإلكتروني',
  'Stop receiving marketing emails at': 'إيقاف استلام الرسائل التسويقية على',
  'Order and account emails are not affected.': 'رسايل الطلبات والحساب مش هتتأثر.',
  Unsubscribe: 'إلغاء الاشتراك',
  'Unsubscribing…': 'بنلغي الاشتراك…',
  'You have been unsubscribed. You will not receive marketing emails from us.':
    'اشتراكك اتلغى. مش هتوصلك رسايل تسويقية مننا تاني.',
  'This unsubscribe link is invalid.': 'رابط إلغاء الاشتراك ده مش صالح.',
  'Something went wrong. Please try again later.': 'حصل خطأ. جرّب تاني بعدين.',

  // SMS-marketing consent (issue 206) — checkout opt-in, account settings, opt-out page.
  'Send me offers by SMS': 'ابعتولي العروض في رسايل SMS',
  'Promotional messages only. You can stop them anytime.': 'رسايل عروض بس. تقدر توقفها في أي وقت.',
  'SMS offers': 'عروض الرسائل القصيرة',
  'Get offers and reminders from this store by SMS.':
    'ابعتولي العروض والتذكيرات من المتجر ده في رسايل SMS.',
  'Order updates are not affected.': 'تحديثات الطلبات مش هتتأثر.',
  'Offers will be sent to': 'العروض هتتبعت على',
  'Add a phone number to your profile to get SMS offers.':
    'ضيف رقم تليفون لملفك الشخصي عشان توصلك عروض الـ SMS.',
  'You are receiving SMS offers.': 'إنت مشترك في عروض الـ SMS.',
  'Stop SMS offers': 'إيقاف عروض الرسائل القصيرة',
  'SMS preferences': 'تفضيلات الرسائل القصيرة',
  'Stop receiving SMS offers at': 'إيقاف استلام عروض الرسائل القصيرة على',
  'Order and delivery messages are not affected.': 'رسايل الطلبات والتوصيل مش هتتأثر.',
  'You will not receive SMS offers from us.': 'مش هتوصلك عروض SMS مننا تاني.',
  'This link is invalid.': 'الرابط ده مش صالح.',

  // Visual builder newsletter section (Phase 2). The consent line is platform
  // copy, not merchant-editable, so every signup form carries it.
  'Your email': 'بريدك الإلكتروني',
  Subscribe: 'اشترك',
  'Subscribing…': 'بنسجّل اشتراكك…',
  'Thanks — you are subscribed.': 'شكرًا — اشتراكك اتسجّل.',
  'Please enter a valid email.': 'اكتب بريد إلكتروني صحيح.',
  'By subscribing you agree to receive marketing emails from this store.':
    'لما تشترك، إنت موافق إنك تستلم رسايل تسويقية من المتجر ده.',
  'Privacy policy': 'سياسة الخصوصية',

  // Editor canvas hints for sections with nothing to show yet (EmptySectionHint).
  // Never shown on the public storefront, which hides these sections instead.
  'Add categories and they will appear here.': 'ضيف أقسام وهتظهر هنا.',
  'Add products and your newest ones will appear here.': 'ضيف منتجات وأحدث منتجاتك هتظهر هنا.',
  'Best sellers appear here once your products start selling.':
    'الأكثر مبيعاً هيظهر هنا أول ما منتجاتك تبدأ تتباع.',
  'Add a store description or image in store settings to show your story here.':
    'ضيف وصف أو صورة للمتجر من إعدادات المتجر وحكايتك هتظهر هنا.',
  'Publish a blog post to show it here.': 'انشر مقال في المدونة وهيظهر هنا.',
  'Write your own trust items (delivery, payment, returns) and they will show here.':
    'اكتب نقاط الثقة بتاعتك (التوصيل، الدفع، الاسترجاع) وهتظهر هنا.',
  'Customer reviews appear here once customers leave them.':
    'آراء العملاء هتظهر هنا أول ما العملاء يكتبوها.',
  'Add a look with a photo and its pieces and it will appear here.':
    'أضف لوك بصورته وقطعه وهيظهر هنا.',
  'Add at least two steps and your routine will appear here.':
    'ضيف خطوتين على الأقل والروتين هيظهر هنا.',
  'Add a name or a photo and your kitchen profile will appear here.':
    'ضيف اسم أو صورة وملف مطبخك هيظهر هنا.',
  'Add photos or a title and your collage will appear here.':
    'ضيف صور أو عنوان والكولاج هيظهر هنا.',
  'Add a photo or a title and your window will appear here.':
    'ضيف صورة أو عنوان والفاترينة هتظهر هنا.',
  'Add at least two figures and your spec sheet will appear here.':
    'ضيف رقمين على الأقل والمواصفات هتظهر هنا.',
  'Add at least two ingredients and they will appear here.': 'ضيف مكوّنين على الأقل وهيظهروا هنا.',
  'Add a dish to at least two days and your kitchen days will appear here.':
    'اكتب أكلة ليومين على الأقل وأيام المطبخ هتظهر هنا.',
  'Kitchen days': 'أيام المطبخ',
  'Add an occasion or a budget and your gift finder will appear here.':
    'ضيف مناسبة أو ميزانية ومساعد الهدايا هيظهر هنا.',
  // Jasmine routine, rating and bundle lines (Phase B3): sentences are Egyptian, buttons neutral.
  'Add all to cart': 'إضافة الكل للسلة',
  'In your cart': 'في سلتك',
  'Instead of': 'بدل',
  'Save {n}% when you buy them together': 'وفّر {n}% لما تشتريهم مع بعض',
  'Save {n}% when you buy it in a bundle': 'وفّر {n}% لما تشتريه في باقة',
  'Out of 5, read the reviews': 'من 5، اقرا التقييمات',
  'Clear filter': 'مسح الفلتر',
  'Add products': 'ضيف منتجات',
  'Add categories': 'ضيف أقسام',
  'Add a picture to this slide': 'ضيف صورة للشريحة دي',
  'Only you see this in the editor. Visitors do not see an empty section.':
    'إنت بس اللي بتشوف ده في المحرر. الزوار مش بيشوفوا قسم فاضي.',

  // Testimonial attribution when the review has no customer name (API sends null). Neutral noun.
  Customer: 'عميل',

  // Accessible name of a whole-slide hero link with no headline or alt (HeroBanner, HeroCollage).
  'View more': 'عرض المزيد',

  // Shop-the-look section (Phase B1 Lookbook). Neutral noun forms, never a gendered imperative.
  'Shop the look': 'شوف اللوك كامل',
  'Items in this look': 'قطع اللوك',
  'Look total': 'مجموع اللوك',
  // W2a "Shop this look" page (amends Ruling B1-6); neutral noun forms (decision (e)).
  'See the full look': 'شوف اللوك كامل',
  'Choose a size for each piece and add the ones you want.':
    'اختيار المقاس لكل قطعة وإضافة القطع المطلوبة.',
  'Choose the options above first': 'اختيار الخيارات أولًا',
  'Personalise on the product page': 'التخصيص من صفحة المنتج',

  // Demo showroom bar (Rulings B1-11/B1-12) and its refusals (B1-13).
  'Demo store': 'متجر تجريبي',
  Template: 'القالب',
  Look: 'الشكل',
  'Choose a look': 'اختر شكلاً',
  'This is a demo store: this is turned off here': 'ده متجر تجريبي — الخاصية دي مقفولة هنا',

  // Route error fallback — Try Again while the refresh is in flight.
  'Retrying…': 'بنجرّب تاني…',
} as const;

export type TranslationKey = keyof typeof translations;
