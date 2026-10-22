'use client';

interface Props {
  error: string;
}

const ERROR_MESSAGES: Record<string, { en: string; ar: string }> = {
  INVALID_TOKEN: {
    en: 'This review link is invalid or has expired (links expire after 90 days).',
    ar: 'رابط التقييم مش صالح أو انتهى (الروابط بتنتهي بعد 90 يوم).',
  },
  ORDER_NOT_DELIVERED: {
    en: 'This order is not eligible for review yet.',
    ar: 'الطلب ده لسه مينفعش يتقيّم.',
  },
  ORDER_NOT_FOUND: {
    en: 'Order not found.',
    ar: 'ملقيناش الطلب.',
  },
  PRODUCT_NOT_FOUND: {
    en: 'Product not found.',
    ar: 'ملقيناش المنتج.',
  },
  ALREADY_REVIEWED: {
    en: 'You have already submitted a review for this product.',
    ar: 'إنت قيّمت المنتج ده قبل كده.',
  },
  NETWORK: {
    en: 'Network error. Please try again later.',
    ar: 'مشكلة في الشبكة. جرّب تاني.',
  },
  UNKNOWN: {
    en: 'Something went wrong. Please try again later.',
    ar: 'حصل خطأ. جرّب تاني.',
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
      <div className="text-5xl mb-4" aria-hidden="true">
        ⚠️
      </div>
      <h1 className="text-xl font-bold mb-3">
        {lang === 'ar' ? 'معرفناش نحمّل فورم التقييم' : "Couldn't load the review form"}
      </h1>
      <p className="text-muted-foreground text-sm">{getMsg(error, lang)}</p>
    </main>
  );
}
