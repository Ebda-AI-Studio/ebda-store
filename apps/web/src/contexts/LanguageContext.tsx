'use client';

import { createContext, useContext, useState, useEffect, useLayoutEffect, ReactNode } from 'react';

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

// Get initial language from localStorage (client-side only)
function getInitialLanguage(storeDefault?: Language): Language {
  if (typeof window === 'undefined') return storeDefault || 'en';
  const savedLang = localStorage.getItem('force-language') as Language;
  if (savedLang && ['en', 'ar'].includes(savedLang)) {
    return savedLang;
  }
  return storeDefault || 'en';
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
    document.body.style.fontFamily =
      language === 'ar'
        ? 'var(--font-arabic), var(--font-sans), sans-serif'
        : 'var(--font-sans), sans-serif';
    localStorage.setItem('force-language', language);
  }, [language, direction]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
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
  'Added to cart': 'تمت الإضافة للسلة',
  'View cart': 'عرض السلة',
  'Shopping Cart': 'سلة التسوق',
  'Your cart is empty': 'سلة التسوق فارغة',
  'Continue Shopping': 'متابعة التسوق',
  Subtotal: 'المجموع الفرعي',
  Shipping: 'الشحن',
  Free: 'مجاني',
  Total: 'الإجمالي',
  'Proceed to Checkout': 'المتابعة للدفع',
  'Order Summary': 'ملخص الطلب',
  'Promo Code': 'كود الخصم',
  Apply: 'تطبيق',

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
  'Returns & Refunds': 'المرتجعات والاستبدال',
  'Privacy Policy': 'سياسة الخصوصية',
  'Terms of Service': 'الشروط والأحكام',
  'About Us': 'من نحن',
  Newsletter: 'النشرة البريدية',
  Email: 'البريد الإلكتروني',
  'We accept:': 'نقبل الدفع عبر:',

  // Common
  Home: 'الرئيسية',
  'All Products': 'كل المنتجات',
  Filter: 'تصفية',
  Sort: 'ترتيب',
  Price: 'السعر',
  'Low to High': 'من الأقل للأعلى',
  'High to Low': 'من الأعلى للأقل',
  Search: 'بحث',
  'No results found': 'لم يتم العثور على نتائج',
  'Loading...': 'جاري التحميل...',
  Error: 'خطأ',
  Success: 'تم بنجاح',
  KWD: 'د.ك',

  // Shipping
  'Free delivery on orders over 20 KWD': 'توصيل مجاني للطلبات فوق 20 د.ك',
  'Same-day delivery across Kuwait': 'توصيل في نفس اليوم في جميع أنحاء الكويت',

  // Auth
  Login: 'دخول',
  Register: 'تسجيل',
  'Create Account': 'إنشاء حساب',
  'Forgot Password?': 'نسيت كلمة المرور؟',
  Password: 'كلمة المرور',
  'Confirm Password': 'تأكيد كلمة المرور',
  'Full Name': 'الاسم الكامل',
  Phone: 'الهاتف',

  // Maintenance / suspended store branded page. Surfaced by
  // `StoreMaintenance` when the resolved store has `status === 'suspended'`.
  // Keep copy short — this is the merchant's last impression on a customer
  // when their store is offline, so the page must read as intentional rather
  // than broken.
  "We'll be back soon": 'سنعود قريباً',
  'is currently undergoing maintenance. Please check back later.':
    'يخضع حالياً لأعمال الصيانة. يرجى المحاولة مرة أخرى لاحقاً.',
  'Need to reach us?': 'تحتاج للتواصل معنا؟',
  'Powered by Force': 'مدعوم من Force',
} as const;

export type TranslationKey = keyof typeof translations;
