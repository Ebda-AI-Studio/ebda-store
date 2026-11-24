'use client';

import { useT } from '@/i18n/useT';
import { ProductSearch, type ProductSummary } from './ProductSearch';
import { SelectedProductCard } from './SelectedProductCard';

interface RelationSectionProps {
  kind: 'crossSell' | 'upsell';
  storeId: string;
  items: ProductSummary[];
  max: number;
  excludeIds: string[];
  onAdd: (product: ProductSummary) => void;
  onRemove: (id: string) => void;
}

export function RelationSection({
  kind,
  storeId,
  items,
  max,
  excludeIds,
  onAdd,
  onRemove,
}: RelationSectionProps) {
  const t = useT(`products.recommendations.${kind}`);
  const tCounts = useT('products.recommendations');

  return (
    <div className="rounded-md border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <span className="flex-shrink-0 text-sm text-muted-foreground">
          {tCounts('counts', { count: items.length, max })}
        </span>
      </div>

      <ProductSearch
        storeId={storeId}
        onSelect={onAdd}
        excludeIds={excludeIds}
        disabled={items.length >= max}
      />

      {items.length >= max && (
        <p className="mt-2 text-xs text-warning-ink">{t('maxReached', { max })}</p>
      )}

      <div className="mt-4 space-y-2">
        {items.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          items.map(product => (
            <SelectedProductCard
              key={product.id}
              product={product}
              onRemove={() => onRemove(product.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
