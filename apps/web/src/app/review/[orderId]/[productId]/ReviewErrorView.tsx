'use client';

interface Props {
  error: string;
}

const ERROR_MESSAGES: Record<string, { en: string; ar: string }> = {
  INVALID_TOKEN: {
    en: 'This review link is invalid or has expired (links expire after 90 days).',
    ar: 'رابط التقييم غير صالح أو منتهي الصلاحية (تنتهي الروابط بعد 90 يومًا).',
  },
  ORDER_NOT_DELIVERED: {
    en: 'This order is not eligible for review yet.',
    ar: 'هذا الطلب غير مؤهل للتقييم بعد.',
  },
  ORDER_NOT_FOUND: {
    en: 'Order not found.',
    ar: 'لم يتم العثور على الطلب.',
  },
  PRODUCT_NOT_FOUND: {
    en: 'Product not found.',
    ar: 'لم يتم العثور على المنتج.',
  },
  ALREADY_REVIEWED: {
    en: 'You have already submitted a review for this product.',
    ar: 'لقد قمت بتقييم هذا المنتج بالفعل.',
  },
  NETWORK: {
    en: 'Network error. Please try again later.',
    ar: 'خطأ في الشبكة. يرجى المحاولة مرة أخرى.',
  },
  UNKNOWN: {
    en: 'Something went wrong. Please try again later.',
    ar: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  },
};

function getMsg(code: string, lang: 'en' | 'ar'): string {
  return ERROR_MESSAGES[code]?.[lang] || ERROR_MESSAGES.UNKNOWN[lang];
}

export function ReviewErrorView({ error }: Props) {
  // Read lang from html attribute (set by LanguageProvider in RootLayout)
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';

  return (
    <main className="max-w-lg mx-auto p-6 text-center" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="text-5xl mb-4" role="img" aria-label="warning">
        ⚠️
      </div>
      <h1 className="text-xl font-bold mb-3">
        {lang === 'ar' ? 'تعذّر تحميل نموذج التقييم' : "Couldn't load the review form"}
      </h1>
      <p className="text-muted-foreground text-sm">{getMsg(error, lang)}</p>
    </main>
  );
}
