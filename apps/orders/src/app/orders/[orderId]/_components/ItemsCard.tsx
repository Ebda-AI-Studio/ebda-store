'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatMoney, fmt } from '@/lib/format';
import type { OrderDetail, OrderLineItem } from '@/lib/orders';

interface ItemsCardProps {
  order: OrderDetail;
  previewLimit?: number;
}

/**
 * Line-items card — mirrors the admin ItemsCard. Product image thumbnails via
 * next/image, qty × unit price, line total, and a "view all" expander when the
 * order has more than `previewLimit` lines.
 */
export function ItemsCard({ order, previewLimit = 5 }: ItemsCardProps) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  const items = order.items;
  const visible = expanded ? items : items.slice(0, previewLimit);
  const hiddenCount = items.length - visible.length;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {t.detail.items}
        </h2>
        <span className="text-xs text-muted-foreground">
          {fmt(t.detail.itemCount, { count: items.length })}
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
          className="mt-3 w-full rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm font-medium text-foreground active:bg-muted"
        >
          {t.detail.viewAll} ({items.length})
        </button>
      )}
      {expanded && items.length > previewLimit && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-3 w-full rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm font-medium text-foreground active:bg-muted"
        >
          {t.detail.showLess}
        </button>
      )}
    </section>
  );
}

function ItemRow({ item, currency }: { item: OrderLineItem; currency?: string }) {
  const { t } = useLanguage();
  const img = item.product?.images?.[0]?.url;
  const lineTotal = item.total ?? (item.price ?? 0) * item.quantity;

  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
        {img ? (
          <Image src={img} alt={item.productName} fill className="object-cover" sizes="56px" />
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
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="line-clamp-2 min-w-0 text-sm font-medium text-foreground">
            {item.productName}
          </p>
          <p className="shrink-0 text-sm font-semibold text-foreground">
            {formatMoney(lineTotal, currency)}
          </p>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {item.variantName && <span>{item.variantName}</span>}
          {item.variantName && <span aria-hidden>·</span>}
          <span>
            {t.detail.qty}: {item.quantity}
            {item.price != null && <> × {formatMoney(item.price, currency)}</>}
          </span>
        </div>
      </div>
    </li>
  );
}
