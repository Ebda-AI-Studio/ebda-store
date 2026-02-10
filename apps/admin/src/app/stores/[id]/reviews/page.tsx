'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';

interface Review {
  id: string;
  rating: number;
  title: string | null;
  comment: string | null;
  isVerified: boolean;
  isApproved: boolean;
  helpfulCount: number;
  createdAt: string;
  product: {
    id: string;
    name: string;
    slug: string;
  };
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className={`h-4 w-4 ${i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

export default function ReviewsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved'>('all');
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });

  const fetchReviews = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/reviews/admin?status=${filter}&page=${meta.page}&limit=${meta.limit}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (response.ok) {
        const data = await response.json();
        setReviews(data.data.reviews);
        setMeta(data.data.meta);
      }
    } catch (error) {
      console.error('Failed to fetch reviews:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, filter, meta.page, meta.limit]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  async function handleApprove(reviewId: string) {
    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/reviews/admin/${reviewId}/approve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchReviews();
    } catch (error) {
      console.error('Failed to approve review:', error);
    }
  }

  async function handleReject(reviewId: string) {
    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/reviews/admin/${reviewId}/reject`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchReviews();
    } catch (error) {
      console.error('Failed to reject review:', error);
    }
  }

  async function handleDelete(reviewId: string) {
    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/reviews/admin/${reviewId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchReviews();
    } catch (error) {
      console.error('Failed to delete review:', error);
    }
  }

  return (
    <AdminLayout title="Reviews" subtitle="Manage product reviews and ratings">
      {/* Filters */}
      <div className="mb-6 flex gap-2">
        <Button
          variant={filter === 'all' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('all')}
        >
          All Reviews
        </Button>
        <Button
          variant={filter === 'pending' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('pending')}
        >
          Pending Approval
        </Button>
        <Button
          variant={filter === 'approved' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('approved')}
        >
          Approved
        </Button>
      </div>

      {/* Reviews List */}
      <div className="rounded-xl border bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading reviews...</div>
        ) : reviews.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No reviews found</div>
        ) : (
          <div className="divide-y">
            {reviews.map(review => (
              <div key={review.id} className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <StarRating rating={review.rating} />
                      <Badge variant={review.isApproved ? 'default' : 'secondary'}>
                        {review.isApproved ? 'Approved' : 'Pending'}
                      </Badge>
                      {review.isVerified && (
                        <Badge variant="outline" className="text-green-600 border-green-300">
                          Verified Purchase
                        </Badge>
                      )}
                    </div>

                    {review.title && (
                      <h3 className="font-semibold text-gray-900 mb-1">{review.title}</h3>
                    )}

                    {review.comment && (
                      <p className="text-gray-600 text-sm mb-3">{review.comment}</p>
                    )}

                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>
                        Product:{' '}
                        <span className="font-medium text-gray-700">{review.product.name}</span>
                      </span>
                      <span>
                        By:{' '}
                        <span className="font-medium text-gray-700">
                          {review.customer
                            ? `${review.customer.firstName} ${review.customer.lastName}`
                            : 'Anonymous'}
                        </span>
                      </span>
                      <span>{formatDate(review.createdAt)}</span>
                      <span>{review.helpfulCount} helpful</span>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {!review.isApproved && (
                      <Button size="sm" onClick={() => handleApprove(review.id)}>
                        Approve
                      </Button>
                    )}
                    {review.isApproved && (
                      <Button variant="outline" size="sm" onClick={() => handleReject(review.id)}>
                        Unapprove
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 hover:bg-red-50"
                      onClick={() => handleDelete(review.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-6 py-3">
            <p className="text-sm text-gray-500">
              Showing {(meta.page - 1) * meta.limit + 1} to{' '}
              {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} reviews
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === 1}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === meta.totalPages}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page + 1 }))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
