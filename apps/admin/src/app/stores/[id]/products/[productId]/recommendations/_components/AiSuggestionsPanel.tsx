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
}

export function AiSuggestionsPanel({ storeId, productId, alreadyInCrossSell, onPromote }: Props) {
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

  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          AI suggestions{' '}
          <span className="text-muted-foreground font-normal">/ اقتراحات الذكاء الاصطناعي</span>
        </h3>
        <Button onClick={load} size="sm" variant="outline">
          Refresh
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        Picks from the last <strong>AI recommendations</strong> sweep. These show automatically on
        the storefront "You might also like" section when no manual cross-sell is set. Click{' '}
        <strong>Promote</strong> to add a pick to the manual cross-sell list (which then takes
        priority over AI picks on the storefront).
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
