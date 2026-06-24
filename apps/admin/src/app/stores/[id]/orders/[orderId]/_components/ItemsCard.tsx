'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { formatMoney } from './format';
import type { OrderDetail, OrderItemDetail } from './types';

interface ItemsCardProps {
  order: OrderDetail;
  previewLimit?: number;
}

export function ItemsCard({ order, previewLimit = 5 }: ItemsCardProps) {
  const t = useT('orders.detail');
  const [expanded, setExpanded] = useState(false);

  const items = order.items;
  const visible = expanded ? items : items.slice(0, previewLimit);
  const hiddenCount = items.length - visible.length;

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('items')}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t('itemCount', { count: items.length })}
        </span>
      </div>

      <ul className="divide-y divide-border/60">
        {visible.map(item => (
          <ItemRow key={item.id} item={item} currency={order.currency} />
        ))}
      </ul>

      {hiddenCount > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 w-full rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors cursor-pointer"
        >
          {t('viewAll')} ({items.length})
        </button>
      )}
      {expanded && items.length > previewLimit && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-3 w-full rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors cursor-pointer"
        >
          {t('showLess')}
        </button>
      )}
    </section>
  );
}

function ItemRow({ item, currency }: { item: OrderItemDetail; currency: string }) {
  const t = useT('orders.detail');
  const locale = useLocale();
  const img = item.product?.images?.[0]?.url;
  // order_items only snapshots the English productName; in Arabic, prefer the
  // live product's name_ar (falls back to the snapshot when absent / deleted).
  const displayName = locale === 'ar' ? item.product?.nameAr || item.productName : item.productName;

  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
        {img ? (
          <Image src={img} alt={displayName} fill className="object-cover" sizes="56px" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground line-clamp-2 min-w-0">{displayName}</p>
          <p className="text-sm font-semibold text-foreground shrink-0">
            {formatMoney(item.total, currency)}
          </p>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {item.variantName && <span>{item.variantName}</span>}
          {item.variantName && <span aria-hidden>·</span>}
          <span>
            {t('qty')}: {item.quantity} × {formatMoney(item.price, currency)}
          </span>
        </div>
      </div>
    </li>
  );
}
