'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '../../lib/api';
import { useT } from '@/i18n/useT';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReturnTimelineRow {
  id: string;
  at: string;
  action: string;
  details: {
    returnNumber?: string | null;
    reason?: string | null;
    refundMethod?: string | null;
    trackingNumber?: string | null;
    notes?: string | null;
  };
  actorName: string | null;
  actorRole: string | null;
}

// ---------------------------------------------------------------------------
// Bilingual EN/AR label map for return audit actions
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, { en: string; ar: string }> = {
  'return.created': { en: 'Return requested', ar: 'تم إنشاء طلب الإرجاع' },
  'return.approved': { en: 'Return approved', ar: 'تمت الموافقة على الإرجاع' },
  'return.rejected': { en: 'Return rejected', ar: 'تم رفض الإرجاع' },
  'return.received': { en: 'Items received', ar: 'تم استلام البضاعة' },
  'return.completed': {
    en: 'Return completed / refund issued',
    ar: 'اكتمل الإرجاع وصدر الاسترداد',
  },
  'return.tracking_updated': { en: 'Tracking number updated', ar: 'تم تحديث رقم التتبع' },
};

function getLabel(action: string): { en: string; ar: string } {
  return (
    ACTION_LABELS[action] ?? {
      en: action.replace(/[._]/g, ' '),
      ar: action.replace(/[._]/g, ' '),
    }
  );
}

// ---------------------------------------------------------------------------
// Icon selection
// ---------------------------------------------------------------------------

type IconVariant = 'success' | 'reject' | 'received' | 'tracking' | 'created';

function getIconVariant(action: string): IconVariant {
  if (action === 'return.completed') return 'success';
  if (action === 'return.rejected') return 'reject';
  if (action === 'return.received') return 'received';
  if (action === 'return.tracking_updated') return 'tracking';
  return 'created';
}

function TimelineIcon({ variant }: { variant: IconVariant }) {
  const base = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full';

  if (variant === 'success') {
    return (
      <span className={`${base} bg-success/10 text-success-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (variant === 'reject') {
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
  }
  if (variant === 'received') {
    return (
      <span className={`${base} bg-info/10 text-info-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      </span>
    );
  }
  if (variant === 'tracking') {
    return (
      <span className={`${base} bg-primary/10 text-primary-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
          />
        </svg>
      </span>
    );
  }
  // created / default
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

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ReturnLifecycleTimelineProps {
  storeId: string;
  returnId: string;
}

export function ReturnLifecycleTimeline({ storeId, returnId }: ReturnLifecycleTimelineProps) {
  const t = useT('components');
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ReturnTimelineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const fetchTimeline = useCallback(async () => {
    if (fetched) return;
    setLoading(true);
    try {
      const { data } = await apiGet<{ timeline: ReturnTimelineRow[] }>(
        `/api/v1/stores/${storeId}/returns/admin/${returnId}/timeline`
      );
      if (data?.timeline) setRows(data.timeline);
    } catch {
      // non-blocking — timeline is supplementary info
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [storeId, returnId, fetched]);

  useEffect(() => {
    if (expanded) fetchTimeline();
  }, [expanded, fetchTimeline]);

  return (
    <section className="rounded-2xl border border-border bg-card mt-4">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between p-4 text-start cursor-pointer"
        aria-expanded={expanded}
      >
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('title')}
        </h3>
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
        <div className="border-t border-border px-4 pb-4 pt-3">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="py-3 text-center text-sm text-muted-foreground">{t('noEvents')}</p>
          )}

          {!loading && rows.length > 0 && (
            <ol className="space-y-0">
              {rows.map((row, idx) => {
                const label = getLabel(row.action);
                const iconVariant = getIconVariant(row.action);
                return (
                  <li key={row.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {/* Vertical connector */}
                    {idx < rows.length - 1 && (
                      <span
                        className="absolute start-4 top-8 h-[calc(100%-2rem)] w-px bg-border"
                        aria-hidden
                      />
                    )}
                    <TimelineIcon variant={iconVariant} />
                    <div className="flex-1 min-w-0 pt-1">
                      {/* Bilingual label */}
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span dir="ltr" className="text-sm font-medium text-foreground">
                          {label.en}
                        </span>
                        <span dir="rtl" className="text-xs text-muted-foreground">
                          {label.ar}
                        </span>
                      </div>

                      {/* Actor */}
                      {row.actorName && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t('by')} {row.actorName}
                          {row.actorRole && (
                            <span className="ms-1 opacity-60">
                              ({row.actorRole.replace('_', ' ')})
                            </span>
                          )}
                        </p>
                      )}

                      {/* Detail lines */}
                      {!!row.details.reason && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t('reasonLabel')} {row.details.reason}
                        </p>
                      )}
                      {!!row.details.refundMethod && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t('refundViaLabel')} {row.details.refundMethod}
                        </p>
                      )}
                      {!!row.details.trackingNumber && (
                        <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                          {row.details.trackingNumber}
                        </p>
                      )}

                      {/* Timestamp */}
                      <time
                        dateTime={row.at}
                        className="mt-1 block text-xs text-muted-foreground cursor-default"
                        title={absoluteTime(row.at)}
                      >
                        {relativeTime(row.at)}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
