'use client';

import { useState } from 'react';
import Image from 'next/image';
import { groupOrderLinesForDisplay, type OrderDisplayLine } from '@force/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatMoney, fmt } from '@/lib/format';
import type { OrderDetail, OrderLineItem } from '@/lib/orders';

interface ItemsCardProps {
  order: OrderDetail;
  previewLimit?: number;
}

/**
 * A bundle purchase expands into one `OrderItem` per component at checkout,
 * all sharing a `bundleGroupId` (one id per BOX — see
 * `packages/shared/src/order-lines.ts`). This is the fulfilment app: like
 * admin's `ItemsCard` (and unlike the customer-facing storefront, which
 * COLLAPSES a box into a single row with no component visibility), the
 * fulfiller needs to know exactly what to physically put in the box. So we
 * reuse the canonical `groupOrderLinesForDisplay` grouper — which the
 * storefront also uses — for the GROUPING + the bundle's name/total, but
 * additionally render its `lines` (the raw component `OrderItem`s the
 * customer must never see) indented beneath, exactly as admin does.
 *
 * `groupOrderLinesForDisplay<T>` requires a numeric `price`; `OrderLineItem`
 * keeps it optional to tolerate legacy/partial payloads elsewhere, so lines
 * are defaulted to `price: item.price ?? 0` purely for the grouping call —
 * every render still reads the original item's own optional `price`.
 */
type GroupableLine = OrderLineItem & { price: number };

function toGroupable(items: OrderLineItem[]): GroupableLine[] {
  return items.map(item => ({ ...item, price: item.price ?? 0 }));
}

export function groupItemsForFulfilment(items: OrderLineItem[]): OrderDisplayLine<GroupableLine>[] {
  return groupOrderLinesForDisplay(toGroupable(items));
}

/**
 * The preview cut, taken in DISPLAY ROWS — group first, then limit, so a
 * box straddling the cut is never rendered as a fraction of itself (the
 * exact P1-2 bug fixed in admin's `ItemsCard`, commit `21e074bd`). Identity
 * for an order with no bundle, where one item is exactly one row.
 */
export function previewRows(
  items: OrderLineItem[],
  previewLimit: number,
  expanded: boolean
): { entries: OrderDisplayLine<GroupableLine>[]; totalRows: number; hiddenRows: number } {
  const allEntries = groupItemsForFulfilment(items);
  const entries = expanded ? allEntries : allEntries.slice(0, previewLimit);
  return {
    entries,
    totalRows: allEntries.length,
    hiddenRows: allEntries.length - entries.length,
  };
}

/**
 * Picks the bundle row's display name: the Arabic snapshot when the current
 * locale is `ar` AND one was actually captured at checkout (older bundles
 * created before `bundleNameAr` existed may have `null` here), else the
 * English snapshot. Pulled out of the JSX so it's unit-testable without a
 * DOM — same rule the `ItemRow`'s own `displayName` already follows.
 */
export function bundleDisplayName(
  entry: { name: string; nameAr: string | null },
  locale: string
): string {
  return locale === 'ar' && entry.nameAr ? entry.nameAr : entry.name;
}

/**
 * Line-items card — mirrors the admin ItemsCard. Product image thumbnails via
 * next/image, qty × unit price, line total, and a "view all" expander when the
 * order has more than `previewLimit` DISPLAY ROWS (a bundle box is one row).
 */
export function ItemsCard({ order, previewLimit = 5 }: ItemsCardProps) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  const items = order.items;
  const { entries, totalRows, hiddenRows } = previewRows(items, previewLimit, expanded);

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
        {entries.map(entry =>
          entry.kind === 'item' ? (
            <ItemRow key={entry.key} item={entry.item} currency={order.currency} />
          ) : (
            <BundleGroupRow
              key={entry.key}
              name={bundleDisplayName(entry, locale)}
              total={entry.total}
              lines={entry.lines}
              currency={order.currency}
            />
          )
        )}
      </ul>

      {hiddenRows > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 w-full rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm font-medium text-foreground active:bg-muted"
        >
          {t.detail.viewAll} ({totalRows})
        </button>
      )}
      {expanded && totalRows > previewLimit && (
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

function BundleGroupRow({
  name,
  total,
  lines,
  currency,
}: {
  name: string;
  total: number;
  lines: GroupableLine[];
  currency?: string;
}) {
  const { t } = useLanguage();

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.bundleBadge}
          </span>
          <p className="line-clamp-1 min-w-0 text-sm font-semibold text-foreground">{name}</p>
        </div>
        <p className="shrink-0 text-sm font-semibold text-foreground">
          {formatMoney(total, currency)}
        </p>
      </div>
      {/* Component lines stay individually visible — the fulfiller needs to
          know exactly what to physically put in the box, not just its
          total. Indented under the bundle header, never collapsed. */}
      <ul className="ms-3 divide-y divide-border/40 border-s-2 border-border/60 ps-3">
        {lines.map(item => (
          <ItemRow key={item.id} item={item} currency={currency} />
        ))}
      </ul>
    </li>
  );
}

function ItemRow({ item, currency }: { item: OrderLineItem; currency?: string }) {
  const { t, locale } = useLanguage();
  const img = item.product?.images?.[0]?.url;
  const lineTotal = item.total ?? (item.price ?? 0) * item.quantity;
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
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="line-clamp-2 min-w-0 text-sm font-medium text-foreground">{displayName}</p>
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
