'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatDateTime, fmt } from '@/lib/format';

interface TimelineRow {
  at: string;
  source: 'audit' | 'shipment' | 'order';
  kind: string;
  fromStatus?: string;
  toStatus?: string;
  details?: string;
  actorName?: string;
  location?: string;
}

interface OrderTimelineProps {
  storeId: string;
  orderId: string;
}

// Bilingual labels for known event kinds (mirrors the admin timeline map).
const KIND_LABELS: Record<string, { en: string; ar: string }> = {
  'order.created': { en: 'Order placed', ar: 'تم إنشاء الطلب' },
  'order.status_changed': { en: 'Status updated', ar: 'تحديث الحالة' },
  'order.shipped': { en: 'Order shipped', ar: 'تم شحن الطلب' },
  'order.delivered': { en: 'Order delivered', ar: 'تم تسليم الطلب' },
  'order.cancelled': { en: 'Order cancelled', ar: 'إلغاء الطلب' },
  'order.refunded': { en: 'Order refunded', ar: 'تم استرداد المبلغ' },
  'order.mark_paid': { en: 'Marked as paid', ar: 'تم التأشير بالدفع' },
  'order.note_added': { en: 'Note added', ar: 'تمت إضافة ملاحظة' },
  'order.payment_link_issued': { en: 'Payment link issued', ar: 'تم إصدار رابط الدفع' },
  'order.coupon_override': { en: 'Coupon rules overridden', ar: 'تم تجاوز شروط الكوبون' },
  'order.stock_override': { en: 'Placed over a stock shortage', ar: 'الطلب اتسجل رغم نقص المخزون' },
  'shipment.created': { en: 'Shipment created', ar: 'إنشاء الشحنة' },
  'shipment.picked_up': { en: 'Package picked up', ar: 'استلام الطرد' },
  'shipment.in_transit': { en: 'In transit', ar: 'في الطريق' },
  'shipment.out_for_delivery': { en: 'Out for delivery', ar: 'في رحلة التوصيل' },
  'shipment.delivered': { en: 'Delivered', ar: 'تم التسليم' },
  'shipment.failed': { en: 'Delivery attempt failed', ar: 'فشلت محاولة التوصيل' },
  'shipment.returned': { en: 'Returned to sender', ar: 'إعادة للمرسل' },
};

function kindLabel(kind: string, locale: 'en' | 'ar'): string {
  return KIND_LABELS[kind]?.[locale] ?? kind.replace(/[._]/g, ' ');
}

type IconType = 'success' | 'cancel' | 'ship' | 'location' | 'admin' | 'default';

function getIconType(kind: string): IconType {
  if (kind.includes('delivered') || kind.includes('paid') || kind.includes('created'))
    return 'success';
  if (kind.includes('cancel') || kind.includes('refund') || kind.includes('failed'))
    return 'cancel';
  if (kind.includes('ship') || kind.includes('transit') || kind.includes('pickup')) return 'ship';
  if (kind.includes('location') || kind.includes('out_for')) return 'location';
  if (kind.includes('note') || kind.includes('admin') || kind.includes('link')) return 'admin';
  return 'default';
}

function TimelineDot({ type }: { type: IconType }) {
  const cls =
    type === 'success'
      ? 'bg-success/10 text-success-ink'
      : type === 'cancel'
        ? 'bg-destructive/10 text-destructive-ink'
        : type === 'ship'
          ? 'bg-info/10 text-info-ink'
          : type === 'location'
            ? 'bg-warning/10 text-warning-ink'
            : type === 'admin'
              ? 'bg-primary/10 text-primary-ink'
              : 'bg-muted text-muted-foreground';
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${cls}`}>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
}

/**
 * Read-only order lifecycle timeline — mirrors the admin OrderLifecycleTimeline,
 * collapsible and lazy-fetched on first expand.
 *
 * The API timeline route is registered as `/:orderId/timeline` on a router
 * already mounted at `/stores/:storeId/orders` (apps/api/src/routes/index.ts),
 * so the full matched path is the clean `/stores/:storeId/orders/:orderId/timeline`.
 * Both the admin and the PWA use this single-segment URL. Failures are swallowed
 * (timeline is supplementary).
 */
export function OrderTimeline({ storeId, orderId }: OrderTimelineProps) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const fetchTimeline = useCallback(async () => {
    if (fetched) return;
    setLoading(true);
    try {
      const { data } = await apiGet<{ timeline: TimelineRow[] }>(
        `/api/v1/stores/${storeId}/orders/${orderId}/timeline`
      );
      if (data?.timeline) setRows(data.timeline);
    } catch {
      // non-blocking — timeline is supplementary info
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [storeId, orderId, fetched]);

  useEffect(() => {
    if (expanded) fetchTimeline();
  }, [expanded, fetchTimeline]);

  return (
    <section className="rounded-2xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between p-4 text-start"
        aria-expanded={expanded}
      >
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {t.detail.timeline}
        </h2>
        <svg
          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-5 pt-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t.detail.timelineEmpty}
            </p>
          )}

          {!loading && rows.length > 0 && (
            <ol className="space-y-0">
              {rows.map((row, idx) => (
                <li key={`${row.at}-${idx}`} className="relative flex gap-3 pb-6 last:pb-0">
                  {idx < rows.length - 1 && (
                    <span
                      className="absolute start-4 top-8 h-[calc(100%-2rem)] w-px bg-border"
                      aria-hidden
                    />
                  )}
                  <TimelineDot type={getIconType(row.kind)} />
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {kindLabel(row.kind, locale)}
                      </span>
                      {row.fromStatus && row.toStatus && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            {row.fromStatus}
                          </span>
                          <span aria-hidden>→</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">{row.toStatus}</span>
                        </span>
                      )}
                    </div>
                    {row.actorName && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {fmt(t.detail.timelineBy, { name: row.actorName })}
                      </p>
                    )}
                    {row.location && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.location}</p>
                    )}
                    {row.details && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.details}</p>
                    )}
                    <time dateTime={row.at} className="mt-1 block text-xs text-muted-foreground">
                      {formatDateTime(row.at, locale)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
