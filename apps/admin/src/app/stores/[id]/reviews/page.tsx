'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge, Modal, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiDelete } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

interface Review {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  language: string;
  verifiedPurchase: boolean;
  status: 'pending' | 'published' | 'rejected' | 'spam';
  rejectionReason: string | null;
  spamScore: number | null;
  ownerResponse: string | null;
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
          className={`h-4 w-4 ${i < rating ? 'text-warning fill-yellow-400' : 'text-muted-foreground/60'}`}
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
  const t = useT('reviews.page');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'published' | 'rejected' | 'spam'>(
    'all'
  );
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const { success: toastSuccess, error: showError } = useToast();

  const fetchReviews = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{ reviews: Review[]; meta: typeof meta }>(
        `/api/v1/stores/${storeId}/reviews/admin?status=${filter}&page=${meta.page}&limit=${meta.limit}`
      );
      if (data) {
        setReviews(data.reviews);
        setMeta(data.meta);
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
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/reviews/admin/${reviewId}/approve`
      );
      if (error) {
        showError(t('errorTitle'), t('toastApproveFailed'));
        return;
      }
      toastSuccess(t('toastApproveTitle'), t('toastApproveBody'));
      fetchReviews();
    } catch (err) {
      console.error('Failed to approve review:', err);
      showError(t('errorTitle'), t('toastApproveFailed'));
    }
  }

  async function handleReject(reviewId: string) {
    try {
      const { error } = await apiPost(`/api/v1/stores/${storeId}/reviews/admin/${reviewId}/reject`);
      if (error) {
        showError(t('errorTitle'), t('toastUnapproveFailed'));
        return;
      }
      toastSuccess(t('toastUnapproveTitle'), t('toastUnapproveBody'));
      fetchReviews();
    } catch (err) {
      console.error('Failed to reject review:', err);
      showError(t('errorTitle'), t('toastUnapproveFailed'));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/reviews/admin/${deleteTarget}`);
      if (error) {
        showError(t('errorTitle'), t('toastDeleteFailed'));
        return;
      }
      toastSuccess(t('toastDeleteTitle'), t('toastDeleteBody'));
      fetchReviews();
    } catch (err) {
      console.error('Failed to delete review:', err);
      showError(t('errorTitle'), t('toastDeleteFailed'));
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {/* Filters */}
      <div className="mb-6 flex gap-2">
        <Button
          variant={filter === 'all' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('all')}
        >
          {t('filterAll')}
        </Button>
        <Button
          variant={filter === 'pending' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('pending')}
        >
          {t('filterPending')}
        </Button>
        <Button
          variant={filter === 'published' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('published')}
        >
          {t('filterApproved')}
        </Button>
        <Button
          variant={filter === 'rejected' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('rejected')}
        >
          {t('filterRejected')}
        </Button>
      </div>

      {/* Reviews List */}
      <div className="rounded-xl border bg-card shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>
        ) : reviews.length === 0 ? (
          <div className="force-empty-state px-6">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L4.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
                />
              </svg>
            </div>
            <p className="font-semibold text-foreground">{t('empty')}</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
          </div>
        ) : (
          <div className="divide-y">
            {reviews.map(review => (
              <div key={review.id} className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <StarRating rating={review.rating} />
                      <Badge variant={review.status === 'published' ? 'default' : 'secondary'}>
                        {review.status === 'published' ? t('approved') : review.status}
                      </Badge>
                      {review.verifiedPurchase && (
                        <Badge variant="outline" className="text-success border-success/40">
                          {t('verifiedPurchase')}
                        </Badge>
                      )}
                    </div>

                    {review.title && (
                      <h3 className="font-semibold text-foreground mb-1">{review.title}</h3>
                    )}

                    <p className="text-muted-foreground text-sm mb-3">{review.body}</p>

                    {review.rejectionReason && (
                      <p className="text-destructive text-xs mb-2">
                        {t('rejectionReason')}: {review.rejectionReason}
                      </p>
                    )}

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>
                        {t('productLabel')}
                        <span className="font-medium text-foreground">{review.product.name}</span>
                      </span>
                      <span>
                        {t('byLabel')}
                        <span className="font-medium text-foreground">
                          {review.customer
                            ? `${review.customer.firstName} ${review.customer.lastName}`
                            : t('anonymous')}
                        </span>
                      </span>
                      <span>{formatDate(review.createdAt)}</span>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {review.status !== 'published' && (
                      <Button size="sm" onClick={() => handleApprove(review.id)}>
                        {t('approve')}
                      </Button>
                    )}
                    {review.status === 'published' && (
                      <Button variant="outline" size="sm" onClick={() => handleReject(review.id)}>
                        {t('unapprove')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/5"
                      onClick={() => setDeleteTarget(review.id)}
                    >
                      {t('delete')}
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
            <p className="text-sm text-muted-foreground">
              {t('paginationShowing', {
                from: (meta.page - 1) * meta.limit + 1,
                to: Math.min(meta.page * meta.limit, meta.total),
                total: meta.total,
              })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === 1}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === meta.totalPages}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page + 1 }))}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteModalTitle')}
      >
        <p className="text-sm text-muted-foreground">{t('deleteModalBody')}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={confirmDelete}>
            {t('delete')}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
