'use client';

import { storeNumerals } from '@ebda/shared';
import { pickLocalizedName } from '../templates/shared/display-helpers';
import { useState, useEffect, useCallback } from 'react';
import Link from './StoreLink';
import { usePathname } from 'next/navigation';
import { Button } from '@ebda/ui';
import { api } from '../lib/api';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { API_URL, hasSessionHint } from '../lib/api';
import { formatDate as formatStoreDate } from '../lib/format-date';
import { SectionRetryNotice } from './SectionRetryNotice';
import { countText, VERIFIED_REVIEWS } from '../lib/plural';

// Visual placeholders for the empty state. CRITICAL: these are NEVER
// emitted as Schema.org Review markup — see ProductDetailPage's JSON-LD
// emission (apps/web/src/app/products/[slug]/page.tsx), gated on real
// verified-purchase published reviews only (Task 29).
// Labeled "Sample — not real reviews" + aria-hidden + opacity-40 so
// no one mistakes them for real customer reviews.
const SAMPLE_CARDS = [
  {
    rating: 5,
    title: 'Loved this — exceeded expectations',
    titleAr: 'أحببته — تجاوز توقعاتي',
    author: 'Verified Buyer',
    authorAr: 'مشتري موثّق',
    body: 'Quality is great, shipped fast. Definitely buying again.',
    bodyAr: 'الجودة ممتازة والشحن سريع. أكيد هشتري تاني.',
  },
  {
    rating: 4,
    title: 'Good value',
    titleAr: 'قيمة جيدة',
    author: 'Verified Buyer',
    authorAr: 'مشتري موثّق',
    body: 'Works as described. Packaging could be better.',
    bodyAr: 'شغال زي الوصف بالظبط. التغليف كان ممكن يبقى أحسن.',
  },
];

interface Review {
  id: string;
  rating: number;
  body?: string;
  /** Legacy alias — API previously returned `comment`, now returns `body`.
   *  Keep both so the component degrades gracefully during deploy roll. */
  comment?: string;
  bodyTranslated?: string | null;
  title?: string;
  language?: string;
  verifiedPurchase?: boolean;
  status?: string;
  createdAt: string;
  reviewer?: {
    firstName?: string;
    lastName?: string;
  };
  // Some APIs return name directly on the review object
  reviewerName?: string;
  /** When the review is pending, this is true only for the author. */
  isMine?: boolean;
  /** Legacy compat — mapped from status !== 'published' in API response. */
  isApproved?: boolean;
  /** Store owner response fields */
  ownerResponse?: string | null;
  ownerResponseAr?: string | null;
  ownerResponseAt?: string | null;
}

interface ReviewsResponse {
  success: boolean;
  data?: {
    reviews: Review[];
    averageRating?: number;
    totalCount?: number;
  };
  error?: { message: string };
}

interface Props {
  storeId: string;
  productId: string;
}

/** Render filled/empty stars for a given numeric rating (1-5). */
function StarDisplay({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'lg' }) {
  const cls = size === 'lg' ? 'h-6 w-6' : 'h-4 w-4';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <svg
          key={star}
          className={`${cls} ${star <= rating ? 'text-[hsl(var(--warning))]' : 'text-muted'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

/** Clickable star selector used in the write-review form. */
function StarSelector({ value, onChange }: { value: number; onChange: (rating: number) => void }) {
  const { t } = useLanguage();
  const [hovered, setHovered] = useState(0);
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          onMouseEnter={() => setHovered(star)}
          onMouseLeave={() => setHovered(0)}
          aria-label={t(`Rate ${star} out of 5`, `تقييم ${star} من 5`)}
          className="focus:outline-none"
        >
          <svg
            className={`h-8 w-8 transition-colors ${
              star <= (hovered || value) ? 'text-[hsl(var(--warning))]' : 'text-muted'
            }`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function getReviewerName(review: Review): string {
  if (review.reviewerName) return review.reviewerName;
  if (review.reviewer?.firstName || review.reviewer?.lastName) {
    return [review.reviewer.firstName, review.reviewer.lastName].filter(Boolean).join(' ');
  }
  return 'Anonymous';
}

export default function ReviewSection({ storeId, productId }: Props) {
  const { store } = useStore();
  const { t, language } = useLanguage();
  const storeUrl = useStoreUrl();
  const pathname = usePathname();

  // Tenant-aware date formatter for review timestamps. Uses the store's
  // timezone so a 23:30 UTC review from an Egypt store reads "Jan 5"
  // (Africa/Cairo), not "Jan 4" (UTC). Western digits unless the store opted
  // into Arabic-Indic (Ruling NUMERALS-1).
  const formatDate = (dateStr: string) =>
    formatStoreDate(dateStr, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });

  const [reviews, setReviews] = useState<Review[]>([]);
  const [averageRating, setAverageRating] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  // Distinguishes a genuine fetch failure from "no reviews yet" — both used
  // to collapse into the same empty state (Lens M graceful degradation).
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  // Track which reviews have the translate toggle active (show bodyTranslated)
  const [translatedIds, setTranslatedIds] = useState<Set<string>>(new Set());

  // Write-review form state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  // The API requires the ORDER the review is for — reviews are verified-purchase
  // only. GET /reviews/can-review/:productId already returns it; the form never
  // asked, so every submission failed createReviewSchema with a 400 regardless
  // of origin. Null means "not eligible / not checked yet".
  const [eligibleOrderId, setEligibleOrderId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Check auth by attempting to fetch profile (cookie-based auth). Only a browser that has held a
  // session asks: a guest's PDP view made a raw /auth/me call and logged a 401 in the console
  // (audit 2026-11-03 #15). The write form needs a signed-in customer, who has the hint.
  useEffect(() => {
    if (typeof window !== 'undefined' && !hasSessionHint()) {
      setIsLoggedIn(false);
      return;
    }
    if (typeof window !== 'undefined') {
      fetch(`${API_URL}/auth/me`, { credentials: 'include' })
        .then(res => setIsLoggedIn(res.ok))
        .catch(() => setIsLoggedIn(false));
    }
  }, []);

  // Resolve the eligible order for this product. Only a customer who bought it
  // may review it, and the API needs that order's id on submit.
  useEffect(() => {
    if (!isLoggedIn || !storeId || !productId) return;
    let cancelled = false;
    api
      .get<{ canReview: boolean; orderId?: string }>(
        `/stores/${storeId}/reviews/can-review/${productId}`
      )
      .then(res => {
        if (cancelled) return;
        setEligibleOrderId(res.success && res.data?.canReview ? (res.data.orderId ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setEligibleOrderId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, storeId, productId]);

  const fetchReviews = useCallback(async () => {
    setIsLoading(true);
    setStatus('loading');
    try {
      const res = await fetch(`${API_URL}/stores/${storeId}/reviews/product/${productId}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const json: ReviewsResponse = await res.json();

      if (json.success && json.data) {
        setReviews(json.data.reviews ?? []);
        setAverageRating(json.data.averageRating ?? 0);
        setTotalCount(json.data.totalCount ?? json.data.reviews?.length ?? 0);
        setStatus('ok');
      } else {
        // A well-formed but unsuccessful response (e.g. server error
        // payload) is a failure, not "no reviews yet" — surface the retry
        // affordance instead of the empty-state sample cards.
        setReviews([]);
        setTotalCount(0);
        setStatus('error');
      }
    } catch {
      setReviews([]);
      setTotalCount(0);
      setStatus('error');
    } finally {
      setIsLoading(false);
    }
  }, [storeId, productId]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  async function handleSubmitReview(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) {
      setSubmitMessage({
        type: 'error',
        text: t('Please select a star rating.', 'اختار تقييم بالنجوم.'),
      });
      return;
    }

    // Mirror the server contract client-side so the shopper gets a readable
    // message instead of a bare 400. createReviewSchema requires body >= 20
    // characters and an orderId proving the purchase.
    if (comment.trim().length < 20) {
      setSubmitMessage({
        type: 'error',
        text: t(
          'Please write at least 20 characters so your review is useful to other shoppers.',
          'اكتب 20 حرف على الأقل عشان تقييمك يفيد اللي بيشتروا بعدك.'
        ),
      });
      return;
    }

    if (!eligibleOrderId) {
      setSubmitMessage({
        type: 'error',
        text: t(
          'Only customers who bought this product can review it.',
          'اللي اشتروا المنتج ده بس يقدروا يقيّموه.'
        ),
      });
      return;
    }

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      // Goes through the ApiClient, NOT a raw fetch. buildHeaders attaches
      // X-Session-ID and X-CSRF-Token; a raw fetch sends neither. Merchant
      // custom origins are no longer CSRF-exempt (that exemption let any
      // merchant-controlled page ride a victim's cookie), so a bare fetch to
      // this non-/public/ route now returns 403 CSRF_MISSING_SESSION on every
      // custom-domain storefront — i.e. for every real merchant.
      // Shape must match createReviewSchema: productId + orderId + rating +
      // `body` (min 20 chars). The form previously sent `comment` and no
      // orderId, so every submission 400'd — on the platform origin too.
      const json = await api.post<unknown>(`/stores/${storeId}/reviews`, {
        productId,
        orderId: eligibleOrderId,
        rating,
        body: comment,
        language: language === 'ar' ? 'ar' : 'en',
      });
      if (json.success) {
        setSubmitMessage({
          type: 'success',
          text: t(
            'Thanks! Your review is awaiting approval — you can see it on this page until the merchant publishes it.',
            'شكرًا! تقييمك مستني الموافقة — تقدر تشوفه هنا لحد ما التاجر ينشره.'
          ),
        });
        setRating(0);
        setComment('');
        setShowForm(false);
        // Refresh review list
        fetchReviews();
      } else {
        setSubmitMessage({
          type: 'error',
          text:
            json.error?.message ||
            t('Failed to submit review. Please try again.', 'التقييم متبعتش. جرّب تاني.'),
        });
      }
    } catch {
      setSubmitMessage({
        type: 'error',
        text: t(
          'Failed to submit review. Please check your connection.',
          'التقييم متبعتش. اتأكد من اتصالك.'
        ),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Toggle translate-to-viewer-locale for a specific review
  const toggleTranslate = (reviewId: string) => {
    setTranslatedIds(prev => {
      const next = new Set(prev);
      if (next.has(reviewId)) {
        next.delete(reviewId);
      } else {
        next.add(reviewId);
      }
      return next;
    });
  };

  // Derive the store name for display - fallback gracefully
  const storeName = pickLocalizedName(store, language === 'ar') || t('Store', 'المتجر');

  return (
    <section id="reviews" className="mt-16 border-t border-border pt-12">
      <h2 className="text-2xl font-bold text-foreground">
        {t('Customer Reviews', 'مراجعات العملاء')}
      </h2>

      {/* Average rating summary — prominent count + verified label */}
      {!isLoading && totalCount > 0 && (
        <div className="mt-4 flex items-center gap-4">
          <span className="text-5xl font-bold text-foreground">{averageRating.toFixed(1)}</span>
          <div>
            <StarDisplay rating={Math.round(averageRating)} size="lg" />
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                `${averageRating.toFixed(1)} out of 5 — ${countText('en', totalCount, VERIFIED_REVIEWS)}`,
                `${averageRating.toFixed(1)} من 5 — ${countText('ar', totalCount, VERIFIED_REVIEWS)}`
              )}
            </p>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="mt-6 flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      )}

      {/* Reviews list */}
      {!isLoading && reviews.length > 0 && (
        <div className="mt-8 space-y-6">
          {reviews.map(review => {
            const isPending =
              review.isMine && (review.status === 'pending' || review.isApproved === false);
            // Determine if a translation toggle is available:
            // show only when bodyTranslated exists and review language differs from viewer locale
            const hasTranslation =
              !!review.bodyTranslated && review.language && review.language !== language;
            const showTranslated = hasTranslation && translatedIds.has(review.id);
            const displayBody = showTranslated
              ? review.bodyTranslated
              : (review.body ?? review.comment);

            // Owner response: use Arabic version when viewer is in Arabic locale
            const ownerResponseText =
              language === 'ar' && review.ownerResponseAr
                ? review.ownerResponseAr
                : review.ownerResponse;

            return (
              <div
                key={review.id}
                className={`rounded-xl border p-6 shadow-sm ${
                  isPending ? 'border-warning/40 bg-warning/5' : 'border-border bg-card'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground">{getReviewerName(review)}</p>
                      {/* Verified purchase badge */}
                      {review.verifiedPurchase && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-ink">
                          <svg
                            className="h-3 w-3"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                            aria-hidden="true"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                          {t('Verified purchase', 'شراء موثّق')}
                        </span>
                      )}
                    </div>
                    <StarDisplay rating={review.rating} />
                  </div>
                  <time className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatDate(review.createdAt)}
                  </time>
                </div>
                {isPending && (
                  <p className="mt-2 text-xs font-medium text-warning-ink">
                    {t(
                      'Your review · pending approval. Only you can see it for now.',
                      'تقييمك · مستني الموافقة. إنت بس اللي تقدر تشوفه دلوقتي.'
                    )}
                  </p>
                )}
                {displayBody && (
                  <p className="mt-3 text-muted-foreground leading-relaxed">{displayBody}</p>
                )}
                {/* Translate toggle — only shown when a translation exists in the other locale */}
                {hasTranslation && (
                  <button
                    type="button"
                    onClick={() => toggleTranslate(review.id)}
                    className="mt-2 text-xs text-primary hover:underline focus:outline-none"
                  >
                    {showTranslated
                      ? t('Show original', 'عرض النص الأصلي')
                      : t('Translate', 'ترجمة')}
                  </button>
                )}
                {/* Owner response */}
                {ownerResponseText && (
                  <div className="mt-4 rounded-lg bg-muted/50 border border-border px-4 py-3">
                    <p className="text-xs font-semibold text-foreground mb-1">
                      {t(`Response from ${storeName}`, `رد من ${storeName}`)}
                    </p>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {ownerResponseText}
                    </p>
                    {review.ownerResponseAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDate(review.ownerResponseAt)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Fetch failure — distinct from "no reviews yet" (Lens M graceful
          degradation). Compact inline retry instead of the sample-card
          empty state, which would otherwise misleadingly imply the store
          just hasn't collected reviews yet. */}
      {!isLoading && status === 'error' && (
        <SectionRetryNotice
          onRetry={fetchReviews}
          message="Couldn't load reviews."
          messageAr="معرفناش نحمّل التقييمات."
          className="mt-6"
        />
      )}

      {/* Empty state — labeled sample cards so the section doesn't feel empty.
          CRITICAL: these are NEVER emitted as Schema.org Review markup.
          JSON-LD emission (page.tsx) is gated on real verified-purchase
          published reviews only (Task 29) — that gate is unchanged here. */}
      {!isLoading && status === 'ok' && reviews.length === 0 && (
        <div className="mt-6">
          <p className="text-muted-foreground mb-8">
            {t(
              'No reviews yet. Be the first to review this product.',
              'مفيش تقييمات لسه. خليك أول واحد يقيّم المنتج ده.'
            )}
          </p>

          {/* Sample cards — aria-hidden so screen readers skip them entirely.
              pointer-events-none so clicks don't land on them.
              opacity-40 + border-dashed to visually signal "not a real card". */}
          <div className="relative" aria-hidden="true">
            {/* Amber badge overlapping the top edge of the card grid */}
            <div className="absolute -top-3 inset-x-0 mx-auto w-fit px-3 py-1 rounded-full bg-amber-100 text-amber-900 text-xs font-semibold uppercase tracking-wide z-10 border border-amber-300">
              {language === 'ar' ? 'مثال — مش تقييمات حقيقية' : 'Sample — not real reviews'}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-40 pointer-events-none select-none">
              {SAMPLE_CARDS.map((s, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4"
                >
                  <div className="flex items-center gap-1 mb-2">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <span key={j} className={j < s.rating ? 'text-amber-400' : 'text-gray-300'}>
                        ★
                      </span>
                    ))}
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {language === 'ar' ? s.titleAr : s.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    — {language === 'ar' ? s.authorAr : s.author}
                  </p>
                  <p className="text-sm mt-2 text-muted-foreground leading-relaxed line-clamp-3">
                    {language === 'ar' ? s.bodyAr : s.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Write a review section */}
      <div className="mt-10">
        {!isLoggedIn ? (
          <p className="text-muted-foreground">
            <Link
              href={`${storeUrl('/auth/login')}?redirect=${encodeURIComponent(pathname || '/')}`}
              className="font-medium text-primary hover:underline"
            >
              {t('Log in', 'تسجيل الدخول')}
            </Link>{' '}
            {t('to write a review.', 'لكتابة مراجعة.')}
          </p>
        ) : !showForm ? (
          <div>
            {submitMessage && (
              <div
                className={`mb-4 rounded-lg p-4 ${
                  submitMessage.type === 'success'
                    ? 'bg-success/10 text-success-ink'
                    : 'bg-destructive/10 text-destructive-ink'
                }`}
              >
                {submitMessage.text}
              </div>
            )}
            <Button onClick={() => setShowForm(true)} variant="outline">
              {t('Write a Review', 'اكتب مراجعة')}
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground mb-4">
              {t('Write a Review', 'اكتب مراجعة')}
            </h3>

            {submitMessage && (
              <div
                className={`mb-4 rounded-lg p-4 ${
                  submitMessage.type === 'success'
                    ? 'bg-success/10 text-success-ink'
                    : 'bg-destructive/10 text-destructive-ink'
                }`}
              >
                {submitMessage.text}
              </div>
            )}

            <form onSubmit={handleSubmitReview} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('Your Rating', 'تقييمك')} <span className="text-destructive-ink">*</span>
                </label>
                <StarSelector value={rating} onChange={setRating} />
              </div>

              <div>
                <label
                  htmlFor="review-comment"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {t('Your Review (optional)', 'مراجعتك (اختياري)')}
                </label>
                <textarea
                  id="review-comment"
                  rows={4}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder={t(
                    `Share your experience with this product from ${storeName}...`,
                    `احكي تجربتك مع المنتج ده من ${storeName}...`
                  )}
                  className="w-full rounded-lg border border-input bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>

              <div className="flex gap-3">
                <Button type="submit" isLoading={isSubmitting}>
                  {t('Submit Review', 'إرسال المراجعة')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowForm(false);
                    setSubmitMessage(null);
                    setRating(0);
                    setComment('');
                  }}
                >
                  {t('Cancel', 'إلغاء')}
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
