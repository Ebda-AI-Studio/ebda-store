'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { intlLocaleForUi } from '@/lib/format';

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

interface OrderLifecycleTimelineProps {
  storeId: string;
  orderId: string;
}

// Bilingual EN/AR labels for known event kinds
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

function kindLabel(kind: string): string {
  return KIND_LABELS[kind]?.en ?? kind.replace(/[._]/g, ' ');
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

function TimelineIcon({ type }: { type: IconType }) {
  const base = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full';
  if (type === 'success')
    return (
      <span className={`${base} bg-success/10 text-success-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  if (type === 'cancel')
    return (
      <span className={`${base} bg-destructive/10 text-destructive-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </span>
    );
  if (type === 'ship')
    return (
      <span className={`${base} bg-info/10 text-info-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 7H4l-1 9h18l-1-9zm-8 12a2 2 0 110-4 2 2 0 010 4zm6 0a2 2 0 110-4 2 2 0 010 4z"
          />
        </svg>
      </span>
    );
  if (type === 'location')
    return (
      <span className={`${base} bg-warning/10 text-warning-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </span>
    );
  if (type === 'admin')
    return (
      <span className={`${base} bg-primary/10 text-primary-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
      </span>
    );
  return (
    <span className={`${base} bg-muted text-muted-foreground`}>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {status}
    </span>
  );
}

export function OrderLifecycleTimeline({ storeId, orderId }: OrderLifecycleTimelineProps) {
  const t = useT('components.orderTimeline');
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
      {/* Collapsible header */}
      <button
        data-ui="row"
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between p-5 text-start"
        aria-expanded={expanded}
      >
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('sectionTitle')}
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
        <div className="border-t border-border px-5 pb-5 pt-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
          )}

          {!loading && rows.length > 0 && (
            <ol className="space-y-0">
              {rows.map((row, idx) => (
                <li key={`${row.at}-${idx}`} className="relative flex gap-3 pb-6 last:pb-0">
                  {/* Connector line */}
                  {idx < rows.length - 1 && (
                    <span
                      className="absolute start-4 top-8 h-[calc(100%-2rem)] w-px bg-border"
                      aria-hidden
                    />
                  )}
                  <TimelineIcon type={getIconType(row.kind)} />
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {kindLabel(row.kind)}
                      </span>
                      {row.fromStatus && row.toStatus && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <StatusChip status={row.fromStatus} />
                          <span>→</span>
                          <StatusChip status={row.toStatus} />
                        </span>
                      )}
                    </div>
                    {row.actorName && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('by', { actorName: row.actorName })}
                      </p>
                    )}
                    {row.location && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.location}</p>
                    )}
                    {row.details && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.details}</p>
                    )}
                    <time dateTime={row.at} className="mt-1 block text-xs text-muted-foreground">
                      {new Date(row.at).toLocaleString(intlLocaleForUi(), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
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
