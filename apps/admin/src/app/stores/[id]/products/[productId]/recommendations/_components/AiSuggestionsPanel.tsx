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
import { Button, useToast } from '@force/ui';
import { apiGet } from '../../../../../../../lib/api';
import type { ProductSummary } from './ProductSearch';

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
  const [recs, setRecs] = useState<AiRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await apiGet<{ recommendations: AiRec[] }>(
      `/api/v1/stores/${storeId}/ai/results/recommendations?productId=${productId}`
    );
    if (err) {
      setError(err.message || 'Failed to load AI suggestions');
      setLoading(false);
      return;
    }
    setRecs(data?.recommendations ?? []);
    setLoading(false);
  }, [storeId, productId]);

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
    toastSuccess(`Added "${rec.targetProduct.name}" to cross-sell`);
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

  const promoteAll = () => {
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
        ? `Promoted ${capped} (max ${maxCrossSell} reached — ${promoted - capped} skipped)`
        : `Promoted ${promoted} AI picks to manual cross-sell`
    );
  };

  const demoteAll = () => {
    if (aiIdsAlreadyAdded.length === 0) return;
    const ok = window.confirm(
      `Remove ${aiIdsAlreadyAdded.length} AI-promoted product(s) from the manual cross-sell list? ` +
        `The storefront will fall back to AI picks (priority tier 2) on the next render.`
    );
    if (!ok) return;
    onDemoteAll(aiIdsAlreadyAdded);
    toastSuccess(`Demoted ${aiIdsAlreadyAdded.length} AI picks back to fallback rendering`);
  };

  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground">
          AI suggestions{' '}
          <span className="text-muted-foreground font-normal">/ اقتراحات الذكاء الاصطناعي</span>
        </h3>
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
                ? 'Nothing to promote — all suggestions already in the cross-sell list'
                : alreadyInCrossSell.length >= maxCrossSell
                  ? `Cross-sell list at max (${maxCrossSell}). Remove an entry first.`
                  : `Promote ${promotableRecs.length} suggestion(s)`
            }
          >
            Promote all{' '}
            <span className="text-muted-foreground/70 ml-1 font-normal">/ ترقية الكل</span>
          </Button>
          <Button
            onClick={demoteAll}
            size="sm"
            variant="outline"
            disabled={loading || aiIdsAlreadyAdded.length === 0}
            title={
              aiIdsAlreadyAdded.length === 0
                ? 'Nothing to demote — none of the AI picks are in the manual cross-sell list'
                : `Demote ${aiIdsAlreadyAdded.length} AI pick(s) back to fallback rendering`
            }
          >
            Demote all <span className="text-muted-foreground/70 ml-1 font-normal">/ خفض الكل</span>
          </Button>
          <Button onClick={load} size="sm" variant="outline">
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        Picks from the last <strong>AI recommendations</strong> sweep. These show automatically on
        the storefront "You might also like" section when no manual cross-sell is set. Click{' '}
        <strong>Promote</strong> to add a single pick, or use <strong>Promote all</strong> /{' '}
        <strong>Demote all</strong> at the top to flip the whole list. Promoted picks take priority
        over the AI defaults on the storefront.
      </p>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error && <div className="text-sm text-destructive">{error}</div>}
      {!loading && !error && recs.length === 0 && (
        <div className="rounded-md bg-background border border-border p-3 text-sm text-muted-foreground">
          No AI suggestions yet for this product. Run the <strong>AI recommendations</strong> sweep
          from{' '}
          <a href={`/stores/${storeId}/ai-tools`} className="text-primary underline">
            AI Tools
          </a>
          .
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
                  {alreadyAdded ? 'Already added' : 'Promote'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
