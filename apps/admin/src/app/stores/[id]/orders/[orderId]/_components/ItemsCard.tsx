'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { mgToGramsString, orderLineVariantTitle } from '@ebda/shared';
import { VariantText } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { formatMoney } from './format';
import type { OrderDetail, OrderItemDetail } from './types';

import { Button } from '@/components/ui/Button';
interface ItemsCardProps {
  order: OrderDetail;
  previewLimit?: number;
}

/**
 * I6 (final review): a bundle purchase expands into one `OrderItem` per
 * component at checkout, all sharing a `bundleGroupId` — one id per BOX. The
 * admin order screen must GROUP and LABEL those lines under the bundle's
 * name (so a merchant fulfilling "Ramadan Box" doesn't see three unrelated
 * products at allocated prices with no idea what they belong to), but —
 * unlike the storefront's `groupOrderLinesForDisplay`, which COLLAPSES a
 * group into one customer-facing row — must keep every component line
 * visible: the merchant needs to know exactly what to physically put in the
 * box. This is a separate, admin-specific grouping (not a reuse of the
 * customer-facing collapse helper), preserving the flat item order.
 */
export type ItemsCardEntry =
  | { kind: 'item'; item: OrderItemDetail }
  | {
      kind: 'group';
      bundleGroupId: string;
      name: string;
      nameAr: string | null;
      items: OrderItemDetail[];
    };

export function groupItemsForAdmin(items: OrderItemDetail[]): ItemsCardEntry[] {
  const entries: ItemsCardEntry[] = [];
  const groupIndex = new Map<string, number>();

  for (const item of items) {
    if (item.bundleGroupId) {
      const idx = groupIndex.get(item.bundleGroupId);
      if (idx === undefined) {
        groupIndex.set(item.bundleGroupId, entries.length);
        entries.push({
          kind: 'group',
          bundleGroupId: item.bundleGroupId,
          name: item.bundleName ?? 'Bundle',
          nameAr: item.bundleNameAr ?? null,
          items: [item],
        });
      } else {
        const existing = entries[idx];
        if (existing.kind === 'group') existing.items.push(item);
      }
    } else {
      entries.push({ kind: 'item', item });
    }
  }

  return entries;
}

/**
 * The preview cut, taken in DISPLAY ROWS.
 *
 * P1-2 (final review): `ItemsCard` used to slice the raw `items` array and
 * THEN group it. With 4 loose lines followed by a 3-component box and
 * `previewLimit = 5`, the slice kept only the box's FIRST component, so
 * `BundleGroupRow` summed one allocated line and the merchant read
 * "Ramadan Box · 3.724 EGP" for a box the customer paid 12.000 for — and
 * "+2 more" counted component lines, not rows. Group first, then limit, so a
 * box is never rendered as a fraction of itself. Identity for an order with
 * no bundle, where one item is exactly one row.
 */
export function previewRows(
  items: OrderItemDetail[],
  previewLimit: number,
  expanded: boolean
): { entries: ItemsCardEntry[]; totalRows: number; hiddenRows: number } {
  const allEntries = groupItemsForAdmin(items);
  const entries = expanded ? allEntries : allEntries.slice(0, previewLimit);
  return {
    entries,
    totalRows: allEntries.length,
    hiddenRows: allEntries.length - entries.length,
  };
}

export function ItemsCard({ order, previewLimit = 5 }: ItemsCardProps) {
  const t = useT('orders.detail');
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);

  const items = order.items;
  const { entries, totalRows, hiddenRows } = previewRows(items, previewLimit, expanded);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('items')}
        </h2>
        <span className="text-xs text-muted-foreground">
          {/* P2-g (scoped re-review): P1-2 fixed the "+N more" button to
              count display ROWS (`totalRows` — one bundle box is one row,
              not its N components); this header count was left counting
              component LINES (`items.length`), so a 4-loose+3-component
              order showed "7 items" above a "View all (5)" button. Both
              now agree. */}
          {t('itemCount', { count: totalRows })}
        </span>
      </div>

      <ul className="divide-y divide-border/60">
        {entries.map(entry =>
          entry.kind === 'item' ? (
            <ItemRow key={entry.item.id} item={entry.item} currency={order.currency} />
          ) : (
            <BundleGroupRow
              key={entry.bundleGroupId}
              name={locale === 'ar' && entry.nameAr ? entry.nameAr : entry.name}
              items={entry.items}
              currency={order.currency}
            />
          )
        )}
      </ul>

      {hiddenRows > 0 && !expanded && (
        <Button
          type="button"
          onClick={() => setExpanded(true)}
          variant="outline"
          className="mt-3 w-full"
        >
          {t('viewAll')} ({totalRows})
        </Button>
      )}
      {expanded && totalRows > previewLimit && (
        <Button
          type="button"
          onClick={() => setExpanded(false)}
          variant="outline"
          className="mt-3 w-full"
        >
          {t('showLess')}
        </Button>
      )}
    </section>
  );
}

function BundleGroupRow({
  name,
  items,
  currency,
}: {
  name: string;
  items: OrderItemDetail[];
  currency: string;
}) {
  const t = useT('orders.detail');
  const groupTotal = items.reduce((sum, i) => sum + i.total, 0);

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('bundleBadge')}
          </span>
          <p className="text-sm font-semibold text-foreground line-clamp-1 min-w-0">{name}</p>
        </div>
        <p className="text-sm font-semibold text-foreground shrink-0">
          {formatMoney(groupTotal, currency)}
        </p>
      </div>
      {/* Component lines stay individually visible — the merchant needs to
          know exactly what to physically put in the box, not just its
          total. Indented under the bundle header, never collapsed. */}
      <ul className="ms-3 ps-3 border-s-2 border-border/60 divide-y divide-border/40">
        {items.map(item => (
          <ItemRow key={item.id} item={item} currency={currency} />
        ))}
      </ul>
    </li>
  );
}

function ItemRow({ item, currency }: { item: OrderItemDetail; currency: string }) {
  const t = useT('orders.detail');
  const locale = useLocale();
  const img = item.product?.images?.[0]?.url;
  // order_items only snapshots the English productName; in Arabic, prefer the
  // live product's name_ar (falls back to the snapshot when absent / deleted).
  const displayName = locale === 'ar' ? item.product?.nameAr || item.productName : item.productName;
  // Per the admin locale, with fallback (Ruling B0-41); one <bdi> per option value (F8).
  const variantName = orderLineVariantTitle(item, locale === 'ar');
  // B2B: the retail price struck through only when the line was sold below it (from the persisted snapshot).
  const struckList =
    item.priceSource && item.priceSource !== 'base' && (item.listPrice ?? 0) > item.price
      ? (item.listPrice as number)
      : null;

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
          {variantName && (
            <span>
              <VariantText title={variantName} />
            </span>
          )}
          {variantName && <span aria-hidden>·</span>}
          <span>
            {t('qty')}: {item.quantity} ×{' '}
            {struckList != null ? (
              <s className="opacity-60">{formatMoney(struckList, currency)}</s>
            ) : null}{' '}
            {formatMoney(item.price, currency)}
          </span>
          {item.priceSource === 'tier' || item.priceSource === 'group' ? (
            <span
              data-testid="order-line-price-label"
              className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary-ink"
            >
              {/* A public quantity break is open to every shopper: "Quantity price", not "Wholesale" (final review minor 4). */}
              {item.priceSource === 'tier' && item.priceTierMinQty != null
                ? t(item.priceGroupApplied === true ? 'priceTier' : 'priceQuantity', {
                    qty: item.priceTierMinQty,
                  })
                : t('priceWholesale')}
            </span>
          ) : null}
        </div>
        {item.personalisation && <PersonalisationRow text={item.personalisation} />}
        {item.goldSnapshot && <GoldSnapshotRow snap={item.goldSnapshot} />}
      </div>
    </li>
  );
}

/** The karat, weight and per-gram rate this line was priced at, so a refund or a dispute can be checked later. */
function GoldSnapshotRow({ snap }: { snap: NonNullable<OrderItemDetail['goldSnapshot']> }) {
  const t = useT('goldRates.snapshot');
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      <span className="font-medium">{t('title')}: </span>
      {t('line', {
        karat: snap.karat,
        grams: mgToGramsString(snap.weightMg),
        rate: formatMoney(snap.ratePerGram),
      })}
    </p>
  );
}

/**
 * The customer's personalisation text, highlighted so the workshop cannot miss
 * it, with a copy button (names are retyped into embroidery / engraving software).
 */
function PersonalisationRow({ text }: { text: string }) {
  const t = useT('orders.detail');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the text stays selectable.
    }
  };
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm">
      <span aria-hidden className="text-muted-foreground">
        ✎
      </span>
      <span className="sr-only">{t('personalisation')}: </span>
      <bdi className="min-w-0 flex-1 font-medium text-foreground select-all break-words">
        {text}
      </bdi>
      <Button
        type="button"
        onClick={copy}
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
      >
        {copied ? t('copied') : t('copyPersonalisation')}
      </Button>
    </div>
  );
}
