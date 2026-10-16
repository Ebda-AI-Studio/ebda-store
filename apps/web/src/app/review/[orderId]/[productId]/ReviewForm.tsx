'use client';

import { useState } from 'react';
import { API_URL } from '../../../../lib/api';
import { countText, STARS } from '../../../../lib/plural';

interface Product {
  id: string;
  name: string;
  nameAr?: string | null;
  images?: string[] | null;
  storeId: string;
}

interface Store {
  name: string;
  nameAr?: string | null;
  slug: string;
  logo?: string | null;
}

interface Props {
  orderId: string;
  productId: string;
  token: string;
  product: Product;
  store: Store;
}

const ERROR_MESSAGES: Record<string, { en: string; ar: string }> = {
  INVALID_TOKEN: {
    en: 'This link is invalid or expired.',
    ar: 'هذا الرابط غير صالح أو منتهي.',
  },
  ORDER_NOT_DELIVERED: {
    en: 'Order is not eligible for review yet.',
    ar: 'الطلب غير مؤهل للتقييم بعد.',
  },
  PRODUCT_NOT_IN_ORDER: {
    en: 'Product not found in this order.',
    ar: 'المنتج غير موجود في هذا الطلب.',
  },
  ALREADY_REVIEWED: {
    en: 'You have already reviewed this product.',
    ar: 'لقد قمت بتقييم هذا المنتج بالفعل.',
  },
  NETWORK: {
    en: 'Network error. Please try again.',
    ar: 'خطأ في الشبكة. يرجى المحاولة مرة أخرى.',
  },
  UNKNOWN: {
    en: 'Something went wrong. Please try again.',
    ar: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  },
};

function errMsg(code: string, lang: 'en' | 'ar'): string {
  return ERROR_MESSAGES[code]?.[lang] || ERROR_MESSAGES.UNKNOWN[lang];
}

export function ReviewForm({ orderId, productId, token, product, store }: Props) {
  // Detect language from html[lang] — set by RootLayout from store.settings.defaultLanguage
  const detectedLang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const lang = detectedLang;
  const isAr = lang === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';

  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productName = isAr && product.nameAr ? product.nameAr : product.name;
  const storeName = isAr && store.nameAr ? store.nameAr : store.name;
  // First image URL (R2 CDN)
  const productImage =
    Array.isArray(product.images) && product.images.length > 0 ? product.images[0] : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (body.trim().length < 20) {
      setError(
        isAr
          ? 'يرجى كتابة تعليق أطول (20 حرفًا على الأقل)'
          : 'Please write a longer review (20 characters minimum)'
      );
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      // API_URL already includes the /api/v1 prefix (see lib/api.ts) — do not
      // re-append it here or the request 404s on /api/v1/api/v1/...
      const res = await fetch(`${API_URL}/public/reviews/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          productId,
          token,
          rating,
          title: title.trim() || null,
          body: body.trim(),
          language: lang,
        }),
      });

      const data = await res.json().catch(() => ({ error: 'NETWORK' }));

      if (!res.ok || !data.ok) {
        setError(errMsg(data.error || 'UNKNOWN', lang));
        setSubmitting(false);
        return;
      }

      setSubmitted(true);
    } catch {
      setError(errMsg('NETWORK', lang));
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="max-w-lg mx-auto p-6 text-center" dir={dir}>
        <div className="text-5xl mb-4" aria-hidden="true">
          ✅
        </div>
        <h1 className="text-2xl font-bold mb-2">
          {isAr ? 'شكراً لتقييمك!' : 'Thanks for your review!'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {isAr
            ? 'سيظهر تقييمك على المتجر بعد المراجعة.'
            : 'Your review will appear on the store after a quick review.'}
        </p>
      </main>
    );
  }

  return (
    <main className="max-w-lg mx-auto p-4 sm:p-6" dir={dir}>
      {/* Product header */}
      <div className="flex items-center gap-3 mb-6">
        {productImage && (
          <img
            src={productImage}
            alt={productName}
            className="w-16 h-16 object-cover rounded-lg border border-border flex-shrink-0"
          />
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight truncate">{productName}</h1>
          <p className="text-sm text-muted-foreground">
            {isAr ? `من ${storeName}` : `From ${storeName}`}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Star rating */}
        <div>
          <label className="block text-sm font-medium mb-2">
            {isAr ? 'تقييمك' : 'Your rating'}
          </label>
          <div
            className="flex gap-1"
            role="group"
            aria-label={isAr ? 'تقييم النجوم' : 'Star rating'}
          >
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                className={`text-3xl leading-none transition-colors ${
                  n <= rating ? 'text-amber-400' : 'text-gray-300 hover:text-amber-300'
                }`}
                aria-label={countText(isAr ? 'ar' : 'en', n, STARS)}
                aria-pressed={n <= rating}
              >
                ★
              </button>
            ))}
          </div>
        </div>

        {/* Title (optional) */}
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="review-title">
            {isAr ? 'عنوان التقييم (اختياري)' : 'Review title (optional)'}
          </label>
          <input
            id="review-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={200}
            autoComplete="off"
            inputMode="text"
            className="w-full border border-border rounded-lg px-3 py-2 text-base bg-background focus:outline-none focus:ring-2 focus:ring-primary sm:text-sm"
            placeholder={isAr ? 'مثال: منتج رائع!' : 'e.g. Great product!'}
          />
        </div>

        {/* Review body */}
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="review-body">
            {isAr ? 'تعليقك' : 'Your review'}
          </label>
          <textarea
            id="review-body"
            value={body}
            onChange={e => setBody(e.target.value)}
            required
            minLength={20}
            maxLength={5000}
            rows={6}
            inputMode="text"
            className="w-full border border-border rounded-lg px-3 py-2 text-base bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-y sm:text-sm"
            placeholder={
              isAr
                ? 'شارك تجربتك مع هذا المنتج... (20 حرفًا كحد أدنى)'
                : 'Share your experience with this product... (minimum 20 characters)'
            }
          />
          <p className="text-xs text-muted-foreground mt-1 text-end">{body.length} / 5000</p>
        </div>

        {error && (
          <p className="text-sm text-destructive-ink bg-destructive/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-primary text-primary-foreground py-3 rounded-lg font-semibold text-sm disabled:opacity-60 hover:opacity-90 transition-opacity"
        >
          {submitting
            ? isAr
              ? 'جاري الإرسال...'
              : 'Submitting...'
            : isAr
              ? 'إرسال التقييم'
              : 'Submit review'}
        </button>
      </form>
    </main>
  );
}
