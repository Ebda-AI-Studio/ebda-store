'use client';

/**
 * AiSuggestionsPanel — shows the AI-generated cross-sell picks for a
 * product (rows from `ai_recommendation` table populated by the
 * bulk-ai-recommendations sweep).
 *
 * Until this component shipped, the bulk-ai-recommendations job
 * completed successfully (e.g. "230 filled, 0 failed, 1 skipped") but
 * the merchant had no UI to view the picks — the admin recommendations
 * page only read manual `product_relations`. AI picks DID surface on
 * the storefront product detail page as "You might also like" — but
 * only when no manual cross-sell was set. Now the merchant sees them
 * here and can promote any pick to a manual cross-sell.
 */

import { useEffect, useState, useCallback } from 'react';
import Image from 'next/image';
import { Button, Modal, useToast } from '@ebda/ui';
import { useConfirm } from '@/hooks/useConfirm';
import { apiGet } from '../../../../../../../lib/api';
import type { ProductSummary } from './ProductSearch';
import { useT } from '@/i18n/useT';

/** Number of promotable items above which a confirmation modal is shown. */
const PROMOTE_ALL_CONFIRM_THRESHOLD = 5;

interface AiRec {
  id: string;
  targetProductId: string;
  score: number | null;
  reason: string | null;
  createdAt: string;
  targetProduct: {
    id: string;
    name: string;
    nameAr: string | null;
    slug: string;
    price: number;
    images: Array<{ url: string; alt: string | null }>;
  } | null;
}

interface Props {
  storeId: string;
  productId: string;
  /** Ids already in manual cross-sell list — disables the "Promote" button. */
  alreadyInCrossSell: string[];
  /** Called when merchant clicks "Promote to cross-sell". Parent appends + persists. */
  onPromote: (product: ProductSummary) => void;
  /**
   * Called when merchant clicks "Demote all". Parent removes the listed
   * ids from the manual cross-sell list. Storefront falls back to AI
   * picks (priority tier 2) on the next render.
   */
  onDemoteAll: (ids: string[]) => void;
  /** Soft cap on manual cross-sell entries — used to gate "Promote all". */
  maxCrossSell: number;
}

export function AiSuggestionsPanel({
  storeId,
  productId,
  alreadyInCrossSell,
  onPromote,
  onDemoteAll,
  maxCrossSell,
}: Props) {
  const t = useT('products.recommendations.aiSuggestions');
  const tCommon = useT('common');
  const [recs, setRecs] = useState<AiRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Controls the "Promote N recommendations?" confirmation modal. */
  const [showPromoteAllModal, setShowPromoteAllModal] = useState(false);
  const { success: toastSuccess } = useToast();
  const askConfirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await apiGet<{ recommendations: AiRec[] }>(
      `/api/v1/stores/${storeId}/ai/results/recommendations?productId=${productId}`
    );
    if (err) {
      setError(err.message || t('errorLoadFailed'));
      setLoading(false);
      return;
    }
    setRecs(data?.recommendations ?? []);
    setLoading(false);
  }, [storeId, productId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const promote = (rec: AiRec) => {
    if (!rec.targetProduct) return;
    const product: ProductSummary = {
      id: rec.targetProduct.id,
      name: rec.targetProduct.name,
      price: rec.targetProduct.price,
      images: rec.targetProduct.images.map(i => ({ url: i.url })),
      status: 'active',
    };
    onPromote(product);
    toastSuccess(t('addedToCrossSell', { name: rec.targetProduct.name }));
  };

  // Suggestions that aren't already in the manual cross-sell list AND
  // have a resolvable target product. The "Promote all" / "Demote all"
  // actions read from this filtered view so the buttons reflect what
  // would actually change.
  const promotableRecs = recs.filter(
    r => r.targetProduct != null && !alreadyInCrossSell.includes(r.targetProduct.id)
  );

  const aiIdsAlreadyAdded = recs
    .map(r => r.targetProduct?.id)
    .filter((id): id is string => typeof id === 'string' && alreadyInCrossSell.includes(id));

  /**
   * Applies all promotable AI picks to the manual cross-sell list.
   * Called either directly (when count ≤ PROMOTE_ALL_CONFIRM_THRESHOLD)
   * or after modal confirmation (when count > threshold).
   *
   * Uses the existing parent PUT /relations flow: onPromote populates
   * client state N times, then the page-level "Save" button sends
   * ONE bulk PUT — no per-item API calls are made here.
   */
  const executePromoteAll = useCallback(() => {
    if (promotableRecs.length === 0) return;
    // Respect the parent's per-row cap. parent.addCrossSell already
    // dedupes + ignores anything past MAX_CROSS_SELL, so we can iterate
    // safely without tracking the running count ourselves.
    let promoted = 0;
    for (const rec of promotableRecs) {
      const tp = rec.targetProduct;
      if (!tp) continue;
      onPromote({
        id: tp.id,
        name: tp.name,
        price: tp.price,
        images: tp.images.map(i => ({ url: i.url })),
        status: 'active',
      });
      promoted++;
    }
    const capped = Math.min(promoted, maxCrossSell - alreadyInCrossSell.length);
    toastSuccess(
      capped < promoted
        ? t('promotedCapped', { capped, max: maxCrossSell, skipped: promoted - capped })
        : t('promotedAll', { count: promoted })
    );
  }, [promotableRecs, onPromote, maxCrossSell, alreadyInCrossSell.length, toastSuccess, t]);

  /**
   * Entry point for the "Promote all" button.
   * Shows a confirmation modal when the count exceeds
   * PROMOTE_ALL_CONFIRM_THRESHOLD to prevent accidental bulk promotions.
   */
  const promoteAll = () => {
    if (promotableRecs.length === 0) return;
    if (promotableRecs.length > PROMOTE_ALL_CONFIRM_THRESHOLD) {
      setShowPromoteAllModal(true);
      return;
    }
    executePromoteAll();
  };

  const demoteAll = async () => {
    if (aiIdsAlreadyAdded.length === 0) return;
    const ok = await askConfirm({
      object: t('demoteDialog.object', { count: aiIdsAlreadyAdded.length }),
      consequence: t('demoteDialog.consequence'),
      confirmLabel: t('demoteDialog.confirmLabel'),
    });
    if (!ok) return;
    onDemoteAll(aiIdsAlreadyAdded);
    toastSuccess(t('demotedToast', { count: aiIdsAlreadyAdded.length }));
  };

  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground">{t('heading')}</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Bulk actions — disabled when there's nothing to act on so the
              empty state is unambiguous. The per-row Promote button still
              works for the granular case. */}
          <Button
            onClick={promoteAll}
            size="sm"
            variant="default"
            disabled={
              loading || promotableRecs.length === 0 || alreadyInCrossSell.length >= maxCrossSell
            }
            title={
              promotableRecs.length === 0
                ? t('promoteAllTitleEmpty')
                : alreadyInCrossSell.length >= maxCrossSell
                  ? t('promoteAllTitleMax', { max: maxCrossSell })
                  : t('promoteAllTitleReady', { count: promotableRecs.length })
            }
          >
            {t('promoteAllButton')}
          </Button>
          <Button
            onClick={demoteAll}
            size="sm"
            variant="outline"
            disabled={loading || aiIdsAlreadyAdded.length === 0}
            title={
              aiIdsAlreadyAdded.length === 0
                ? t('demoteAllTitleEmpty')
                : t('demoteAllTitleReady', { count: aiIdsAlreadyAdded.length })
            }
          >
            {t('demoteAllButton')}
          </Button>
          <Button onClick={load} size="sm" variant="outline">
            {t('refresh')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        {t.rich('description', { b: chunks => <strong>{chunks}</strong> })}
      </p>

      {loading && <div className="text-sm text-muted-foreground">{t('loading')}</div>}
      {error && <div className="text-sm text-destructive-ink">{error}</div>}
      {!loading && !error && recs.length === 0 && (
        <div className="rounded-md bg-background border border-border p-3 text-sm text-muted-foreground">
          {t.rich('emptyState', {
            b: chunks => <strong>{chunks}</strong>,
            a: chunks => (
              <a href={`/stores/${storeId}/ai-tools`} className="text-primary underline">
                {chunks}
              </a>
            ),
          })}
        </div>
      )}
      {!loading && recs.length > 0 && (
        <ul className="space-y-2">
          {recs.map(rec => {
            const tp = rec.targetProduct;
            if (!tp) return null;
            const alreadyAdded = alreadyInCrossSell.includes(tp.id);
            const scorePct =
              rec.score == null ? null : Math.round(Math.max(0, Math.min(1, rec.score)) * 100);
            return (
              <li
                key={rec.id}
                className="flex items-center gap-3 rounded-md bg-background border border-border p-2"
              >
                {tp.images[0]?.url ? (
                  <Image
                    src={tp.images[0].url}
                    alt={tp.images[0].alt ?? tp.name}
                    width={44}
                    height={44}
                    unoptimized
                    className="rounded object-cover"
                  />
                ) : (
                  <div className="h-11 w-11 rounded bg-muted" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{tp.name}</p>
                  {rec.reason && (
                    <p className="text-xs text-muted-foreground truncate" title={rec.reason}>
                      {rec.reason}
                    </p>
                  )}
                </div>
                {scorePct != null && (
                  <span className="text-xs text-muted-foreground shrink-0">{scorePct}%</span>
                )}
                <Button
                  size="sm"
                  variant={alreadyAdded ? 'outline' : 'default'}
                  disabled={alreadyAdded}
                  onClick={() => promote(rec)}
                  className="shrink-0"
                >
                  {alreadyAdded ? t('alreadyAdded') : t('promoteButton')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Confirmation modal — shown when "Promote all" is clicked for
          more than PROMOTE_ALL_CONFIRM_THRESHOLD items to prevent
          accidental bulk promotions. */}
      <Modal
        isOpen={showPromoteAllModal}
        onClose={() => setShowPromoteAllModal(false)}
        title={t('confirmModal.title')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground mb-4">
          {t.rich('confirmModal.body', {
            count: promotableRecs.length,
            b: chunks => <strong>{chunks}</strong>,
          })}
        </p>
        <div className="flex justify-end gap-3">
          <Button size="sm" variant="outline" onClick={() => setShowPromoteAllModal(false)}>
            {tCommon('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setShowPromoteAllModal(false);
              executePromoteAll();
            }}
          >
            {t('confirmModal.confirmButton', { count: promotableRecs.length })}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
