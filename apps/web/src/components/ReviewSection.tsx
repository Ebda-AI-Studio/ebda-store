'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { useStore } from '../contexts/StoreContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

interface Review {
  id: string;
  rating: number;
  comment?: string;
  createdAt: string;
  reviewer?: {
    firstName?: string;
    lastName?: string;
  };
  // Some APIs return name directly on the review object
  reviewerName?: string;
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
          className={`${cls} ${star <= rating ? 'text-yellow-400' : 'text-gray-200'}`}
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
          aria-label={`Rate ${star} out of 5`}
          className="focus:outline-none"
        >
          <svg
            className={`h-8 w-8 transition-colors ${
              star <= (hovered || value) ? 'text-yellow-400' : 'text-gray-200'
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

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
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

  const [reviews, setReviews] = useState<Review[]>([]);
  const [averageRating, setAverageRating] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Write-review form state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Check auth token on mount (client-only)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsLoggedIn(!!localStorage.getItem('accessToken'));
    }
  }, []);

  const fetchReviews = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(`${API_URL}/stores/${storeId}/reviews?productId=${productId}`, {
        headers,
      });
      const json: ReviewsResponse = await res.json();

      if (json.success && json.data) {
        setReviews(json.data.reviews ?? []);
        setAverageRating(json.data.averageRating ?? 0);
        setTotalCount(json.data.totalCount ?? json.data.reviews?.length ?? 0);
      } else {
        setFetchError(json.error?.message || 'Failed to load reviews');
      }
    } catch {
      setFetchError('Unable to load reviews. Please check your connection.');
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
      setSubmitMessage({ type: 'error', text: 'Please select a star rating.' });
      return;
    }

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const res = await fetch(`${API_URL}/stores/${storeId}/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ productId, rating, comment }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setSubmitMessage({ type: 'success', text: 'Your review has been submitted. Thank you!' });
        setRating(0);
        setComment('');
        setShowForm(false);
        // Refresh review list
        fetchReviews();
      } else {
        setSubmitMessage({
          type: 'error',
          text: json.error?.message || 'Failed to submit review. Please try again.',
        });
      }
    } catch {
      setSubmitMessage({
        type: 'error',
        text: 'Failed to submit review. Please check your connection.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Derive the store name for display - fallback gracefully
  const storeName = store?.name || 'Store';

  return (
    <section className="mt-16 border-t border-border pt-12">
      <h2 className="text-2xl font-bold text-foreground">Customer Reviews</h2>

      {/* Average rating summary */}
      {!isLoading && !fetchError && totalCount > 0 && (
        <div className="mt-4 flex items-center gap-4">
          <span className="text-5xl font-bold text-foreground">{averageRating.toFixed(1)}</span>
          <div>
            <StarDisplay rating={Math.round(averageRating)} size="lg" />
            <p className="mt-1 text-sm text-muted-foreground">
              Based on {totalCount} {totalCount === 1 ? 'review' : 'reviews'}
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

      {/* Fetch error */}
      {!isLoading && fetchError && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {fetchError}
        </div>
      )}

      {/* Reviews list */}
      {!isLoading && !fetchError && reviews.length > 0 && (
        <div className="mt-8 space-y-6">
          {reviews.map(review => (
            <div key={review.id} className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-foreground">{getReviewerName(review)}</p>
                  <StarDisplay rating={review.rating} />
                </div>
                <time className="text-sm text-muted-foreground whitespace-nowrap">
                  {formatDate(review.createdAt)}
                </time>
              </div>
              {review.comment && (
                <p className="mt-3 text-muted-foreground leading-relaxed">{review.comment}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !fetchError && reviews.length === 0 && (
        <p className="mt-6 text-muted-foreground">
          No reviews yet for this product. Be the first to share your thoughts!
        </p>
      )}

      {/* Write a review section */}
      <div className="mt-10">
        {!isLoggedIn ? (
          <p className="text-muted-foreground">
            <Link href="/auth/login" className="font-medium text-primary hover:underline">
              Log in
            </Link>{' '}
            to write a review.
          </p>
        ) : !showForm ? (
          <div>
            {submitMessage && (
              <div
                className={`mb-4 rounded-lg p-4 ${
                  submitMessage.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {submitMessage.text}
              </div>
            )}
            <Button onClick={() => setShowForm(true)} variant="outline">
              Write a Review
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground mb-4">Write a Review</h3>

            {submitMessage && (
              <div
                className={`mb-4 rounded-lg p-4 ${
                  submitMessage.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {submitMessage.text}
              </div>
            )}

            <form onSubmit={handleSubmitReview} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Your Rating <span className="text-red-500">*</span>
                </label>
                <StarSelector value={rating} onChange={setRating} />
              </div>

              <div>
                <label
                  htmlFor="review-comment"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  Your Review (optional)
                </label>
                <textarea
                  id="review-comment"
                  rows={4}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder={`Share your experience with this product from ${storeName}...`}
                  className="w-full rounded-lg border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              </div>

              <div className="flex gap-3">
                <Button type="submit" isLoading={isSubmitting}>
                  Submit Review
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
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
