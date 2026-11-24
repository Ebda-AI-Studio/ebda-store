'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Badge, Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { SearchInput } from '../../../../components/SearchInput';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { useLatestRequest } from '../../../../hooks/useLatestRequest';

interface Review {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  language: string;
  bodyTranslated: string | null;
  verifiedPurchase: boolean;
  status: 'pending' | 'published' | 'rejected' | 'spam';
  rejectionReason: string | null;
  spamScore: number | null;
  spamReasons: string[] | null;
  ownerResponse: string | null;
  ownerResponseAr: string | null;
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

interface ReviewSummary {
  topPositives: string[];
  topNegatives: string[];
  overallSentiment: 'positive' | 'mixed' | 'negative';
  reviewCount: number;
}

interface OwnerResponseDraft {
  en: string;
  ar: string;
}

import { formatDate } from '@/lib/format';
import { TEXTAREA_CLASSES } from '@/components/ui/tokens';
import { EmptyState } from '@/components/EmptyState';

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className={`h-4 w-4 ${i < rating ? 'text-warning-ink fill-warning' : 'text-muted-foreground/60'}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

function SpamBadge({ score }: { score: number | null }) {
  const t = useT('reviews');
  if (score === null) return null;
  const pct = Math.round(score * 100);
  const variant = score >= 0.7 ? 'destructive' : score >= 0.3 ? 'secondary' : 'outline';
  return (
    <Badge variant={variant as 'destructive' | 'secondary' | 'outline'} className="text-xs">
      {t('spam')} {pct}%
    </Badge>
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
  // Bumped after approve/reject/delete: the fetch effect owns EVERY list request, so the refetch
  // reads the CURRENT filter/page, not the ones captured at render time (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const { success: toastSuccess, error: showError } = useToast();
  // Debounced search term — client-side filter over the current page of reviews.
  const [search, setSearch] = useState('');

  // Translate toggle — per review show bodyTranslated when available
  const [showTranslated, setShowTranslated] = useState<Record<string, boolean>>({});

  // Summary modal — keyed by productId
  const [summaryTarget, setSummaryTarget] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);

  // Draft response modal — keyed by reviewId
  const [draftTarget, setDraftTarget] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftEn, setDraftEn] = useState('');
  const [draftAr, setDraftAr] = useState('');
  const [savingResponse, setSavingResponse] = useState(false);

  // Client-side filter: match customer name, product name, or review body
  // (case-insensitive). Applied on top of the status filter + pagination.
  const filteredReviews = useMemo(() => {
    if (!search.trim()) return reviews;
    const q = search.toLowerCase();
    return reviews.filter(
      review =>
        review.product.name.toLowerCase().includes(q) ||
        review.body.toLowerCase().includes(q) ||
        (review.customer
          ? `${review.customer.firstName} ${review.customer.lastName}`.toLowerCase().includes(q) ||
            review.customer.email.toLowerCase().includes(q)
          : false)
    );
  }, [reviews, search]);

  // Latest-request-wins: a slower response for a previous filter/page must not repaint its rows.
  const beginRequest = useLatestRequest();
  const fetchReviews = useCallback(async () => {
    if (!storeId) return;
    const isLatest = beginRequest();
    setIsLoading(true);
    try {
      const { data } = await apiGet<{ reviews: Review[]; meta: typeof meta }>(
        `/api/v1/stores/${storeId}/reviews/admin?status=${filter}&page=${meta.page}&limit=${meta.limit}`
      );
      if (!isLatest()) return;
      if (data) {
        setReviews(data.reviews);
        setMeta(data.meta);
      }
    } catch (error) {
      if (isLatest()) console.error('Failed to fetch reviews:', error);
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [storeId, filter, meta.page, meta.limit, beginRequest]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews, refreshKey]);

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
      setRefreshKey(k => k + 1);
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
      setRefreshKey(k => k + 1);
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
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('Failed to delete review:', err);
      showError(t('errorTitle'), t('toastDeleteFailed'));
    } finally {
      setDeleteTarget(null);
    }
  }

  // ── AI: summarize product reviews ─────────────────────────────────────────
  async function handleSummarize(productId: string) {
    setSummaryTarget(productId);
    setSummary(null);
    setSummaryLoading(true);
    try {
      const { data, error } = await apiPost<ReviewSummary>(
        `/api/v1/stores/${storeId}/reviews/admin/products/${productId}/summary`
      );
      if (error || !data) {
        showError(t('errorTitle'), t('aiErrorGeneric'));
        setSummaryTarget(null);
        return;
      }
      setSummary(data);
    } catch (err) {
      console.error('Failed to summarize:', err);
      showError(t('errorTitle'), t('aiErrorGeneric'));
      setSummaryTarget(null);
    } finally {
      setSummaryLoading(false);
    }
  }

  // ── AI: draft owner response ───────────────────────────────────────────────
  async function handleDraftResponse(reviewId: string) {
    setDraftTarget(reviewId);
    setDraftEn('');
    setDraftAr('');
    setDraftLoading(true);
    try {
      const { data, error } = await apiPost<OwnerResponseDraft>(
        `/api/v1/stores/${storeId}/reviews/admin/${reviewId}/draft-response`
      );
      if (error || !data) {
        showError(t('errorTitle'), t('aiErrorGeneric'));
        setDraftTarget(null);
        return;
      }
      setDraftEn(data.en);
      setDraftAr(data.ar);
    } catch (err) {
      console.error('Failed to draft response:', err);
      showError(t('errorTitle'), t('aiErrorGeneric'));
      setDraftTarget(null);
    } finally {
      setDraftLoading(false);
    }
  }

  async function handleSaveResponse() {
    if (!draftTarget) return;
    setSavingResponse(true);
    try {
      const { error } = await apiPut(
        `/api/v1/stores/${storeId}/reviews/admin/${draftTarget}/owner-response`,
        { ownerResponse: draftEn, ownerResponseAr: draftAr }
      );
      if (error) {
        showError(t('errorTitle'), t('aiSaveResponseFailed'));
        return;
      }
      toastSuccess(t('aiSaveResponseTitle'), t('aiSaveResponseBody'));
      setDraftTarget(null);
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('Failed to save response:', err);
      showError(t('errorTitle'), t('aiSaveResponseFailed'));
    } finally {
      setSavingResponse(false);
    }
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {/* Search bar */}
      <div className="mb-4">
        <SearchInput
          value={search}
          onSearch={setSearch}
          placeholder={t('searchPlaceholder')}
          className="w-full sm:w-72"
        />
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap gap-2">
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
        <Button
          variant={filter === 'spam' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('spam')}
        >
          {t('filterSpam')}
        </Button>
      </div>

      {/* Reviews List */}
      <div className="rounded-md border bg-card shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>
        ) : filteredReviews.length === 0 ? (
          <EmptyState
            icon="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L4.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
            title={t('empty')}
            description={t('emptyDescription')}
            action={{ label: t('emptyAction'), href: `/stores/${storeId}/products` }}
          />
        ) : (
          <div className="divide-y">
            {filteredReviews.map(review => {
              const isTranslated = showTranslated[review.id];
              const displayBody =
                isTranslated && review.bodyTranslated ? review.bodyTranslated : review.body;
              return (
                <div key={review.id} className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {/* Row 1: Rating + badges */}
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <StarRating rating={review.rating} />
                        <Badge variant={review.status === 'published' ? 'default' : 'secondary'}>
                          {review.status === 'published' ? t('approved') : review.status}
                        </Badge>
                        {review.verifiedPurchase && (
                          <Badge variant="outline" className="text-success-ink border-success/40">
                            {t('verifiedPurchase')}
                          </Badge>
                        )}
                        <SpamBadge score={review.spamScore} />
                      </div>

                      {review.title && (
                        <h3 className="font-semibold text-foreground mb-1">{review.title}</h3>
                      )}

                      {/* Review body with translate toggle */}
                      <p
                        className="text-muted-foreground text-sm mb-1"
                        dir={isTranslated ? (review.language === 'ar' ? 'ltr' : 'rtl') : undefined}
                      >
                        {displayBody}
                      </p>
                      {review.bodyTranslated && (
                        <Button
                          variant="link"
                          size="sm"
                          className="mb-2"
                          onClick={() =>
                            setShowTranslated(prev => ({
                              ...prev,
                              [review.id]: !prev[review.id],
                            }))
                          }
                        >
                          {isTranslated
                            ? t('showOriginal')
                            : t('showTranslated', { lang: review.language === 'ar' ? 'AR' : 'EN' })}
                        </Button>
                      )}

                      {/* Spam reasons */}
                      {review.spamReasons && review.spamReasons.length > 0 && (
                        <p className="text-xs text-destructive-ink mb-2">
                          {t('spamReasons')}: {review.spamReasons.join(', ')}
                        </p>
                      )}

                      {review.rejectionReason && (
                        <p className="text-destructive-ink text-xs mb-2">
                          {t('rejectionReason')}: {review.rejectionReason}
                        </p>
                      )}

                      {/* Existing owner response */}
                      {review.ownerResponse && (
                        <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
                          <span className="font-medium text-foreground">
                            {t('ownerResponse')}:{' '}
                          </span>
                          {review.ownerResponse}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground mt-2">
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

                    {/* Action buttons */}
                    <div className="flex flex-col gap-2 shrink-0">
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
                      {/* AI: Draft response */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDraftResponse(review.id)}
                        disabled={draftLoading && draftTarget === review.id}
                      >
                        {draftLoading && draftTarget === review.id
                          ? t('aiDrafting')
                          : t('draftResponse')}
                      </Button>
                      {/* AI: Summarize this product's reviews */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSummarize(review.product.id)}
                        disabled={summaryLoading && summaryTarget === review.product.id}
                      >
                        {summaryLoading && summaryTarget === review.product.id
                          ? t('aiSummarizing')
                          : t('summarize')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive-ink hover:bg-destructive/5"
                        onClick={() => setDeleteTarget(review.id)}
                      >
                        {t('delete')}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
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
                disabled={meta.page === 1}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
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

      {/* AI: Summary Modal */}
      <Modal
        isOpen={!!summaryTarget && !summaryLoading}
        onClose={() => {
          setSummaryTarget(null);
          setSummary(null);
        }}
        title={t('aiSummaryTitle')}
      >
        {summary ? (
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-semibold text-foreground mb-1">{t('aiSummaryPositives')}</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                {summary.topPositives.length > 0 ? (
                  summary.topPositives.map((p, i) => <li key={i}>{p}</li>)
                ) : (
                  <li>{t('aiSummaryNone')}</li>
                )}
              </ul>
            </div>
            <div>
              <p className="font-semibold text-foreground mb-1">{t('aiSummaryNegatives')}</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                {summary.topNegatives.length > 0 ? (
                  summary.topNegatives.map((n, i) => <li key={i}>{n}</li>)
                ) : (
                  <li>{t('aiSummaryNone')}</li>
                )}
              </ul>
            </div>
            <p className="text-muted-foreground">
              {t('aiSummarySentiment')}:{' '}
              <span className="font-medium text-foreground capitalize">
                {summary.overallSentiment}
              </span>
              {' · '}
              {t('aiSummaryCount', { count: summary.reviewCount })}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        )}
        <div className="mt-6 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSummaryTarget(null);
              setSummary(null);
            }}
          >
            {t('cancel')}
          </Button>
        </div>
      </Modal>

      {/* AI: Draft Response Modal */}
      <Modal
        isOpen={!!draftTarget && !draftLoading}
        onClose={() => setDraftTarget(null)}
        title={t('aiDraftTitle')}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              {t('aiDraftEnLabel')}
            </label>
            <textarea
              className={`${TEXTAREA_CLASSES} resize-none`}
              rows={4}
              value={draftEn}
              onChange={e => setDraftEn(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              {t('aiDraftArLabel')}
            </label>
            <textarea
              className={`${TEXTAREA_CLASSES} resize-none`}
              rows={4}
              dir="rtl"
              value={draftAr}
              onChange={e => setDraftAr(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('aiDraftHint')}</p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={() => setDraftTarget(null)}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={handleSaveResponse} disabled={savingResponse}>
            {savingResponse ? t('saving') : t('aiSaveResponse')}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
