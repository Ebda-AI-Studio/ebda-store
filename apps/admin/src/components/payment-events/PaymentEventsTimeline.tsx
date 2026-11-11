'use client';

import { Button } from '@/components/ui/Button';
import { useState, useCallback, useEffect } from 'react';
import { Modal } from '@ebda/ui';
import { apiGet } from '@/lib/api';
import { useT } from '@/i18n/useT';
import { intlLocaleForUi } from '@/lib/format';
import { minorToDecimalString } from '@ebda/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaymentEvent {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  provider: string | null;
  // The API stores `details` as either a plain string OR a JSON object
  // (e.g. payment-confirm writes `{ source, reason, providerStatus }`).
  // Rendering it raw throws React error #31 — always pass it through
  // `formatDetails` before putting it in JSX.
  details: string | Record<string, unknown> | null;
  triggeredByUserId: string | null;
  occurredAt: string;
  createdAt: string;
}

interface PaymentEventPayload extends PaymentEvent {
  providerPayload: unknown;
}

// ---------------------------------------------------------------------------
// Event-type label — locale-driven via i18n; falls back to a humanized
// version of the raw event type for anything not in the translated set.
// ---------------------------------------------------------------------------

function getLabel(
  t: (key: string) => string,
  hasKey: (key: string) => boolean,
  eventType: string
): string {
  const key = `eventTypes.${eventType}`;
  return hasKey(key) ? t(key) : eventType.replace(/_/g, ' ');
}

// `details` may be a string OR a JSON object (payment-confirm writes
// `{ source, reason, providerStatus }`). Reduce it to a human-readable
// string so it can never be rendered as a raw React child (error #31).
/** A wallet give-back the order's one refundable balance cut short (#659): the merchant settles the rest by hand. */
function walletTrimOf(
  details: unknown
): { planned: number; credited: number; short: number } | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  if (d.reason !== 'wallet_giveback_trimmed') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { planned: n(d.planned), credited: n(d.credited), short: n(d.short) };
}

function formatDetails(details: unknown): string | null {
  if (details == null) return null;
  if (typeof details === 'string') return details.trim() || null;
  if (typeof details === 'object') {
    const d = details as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof d.reason === 'string') parts.push(d.reason.replace(/_/g, ' '));
    if (typeof d.providerStatus === 'string') parts.push(`(${d.providerStatus})`);
    if (typeof d.source === 'string') parts.push(`· ${d.source}`);
    if (parts.length) return parts.join(' ');
    try {
      return JSON.stringify(d);
    } catch {
      return null;
    }
  }
  return String(details);
}

// ---------------------------------------------------------------------------
// Icon selection based on event type
// ---------------------------------------------------------------------------

type IconVariant = 'success' | 'failure' | 'webhook' | 'admin';

function getIconVariant(eventType: string): IconVariant {
  if (['completed', 'refund_completed', 'refund_reconciled'].includes(eventType)) return 'success';
  if (
    [
      'failed',
      'refund_failed',
      'refund_indeterminate',
      'cancelled',
      'expired',
      'webhook_corrected',
    ].includes(eventType)
  )
    return 'failure';
  if (['webhook_received', 'webhook_confirmed', 'status_change', 'retry'].includes(eventType))
    return 'webhook';
  return 'admin';
}

function EventIcon({ variant }: { variant: IconVariant }) {
  // ✅ success — green check
  if (variant === 'success') {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-ink">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  // ❌ failure — red X
  if (variant === 'failure') {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive-ink">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </div>
    );
  }
  // 🔄 webhook — refresh arrows
  if (variant === 'webhook') {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info/10 text-info-ink">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      </div>
    );
  }
  // 🔧 admin / reconciliation — wrench-like settings
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relative time formatter (no external dep)
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
  return new Date(iso).toLocaleString(intlLocaleForUi('en-GB'), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ---------------------------------------------------------------------------
// Status chip — small pill for fromStatus → toStatus transitions
// ---------------------------------------------------------------------------

function StatusChip({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span>{from}</span>
      <svg
        className="h-3 w-3 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
      <span>{to}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Provider badge
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  paymob: 'Paymob',
  kashier: 'Kashier',
  fawry: 'Fawry',
  geidea: 'Geidea',
  instapay: 'InstaPay',
  cod: 'COD',
};

function ProviderBadge({ provider }: { provider: string }) {
  const label = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  return (
    <span className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 text-xs font-medium text-foreground">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Raw payload modal (super_admin only)
// ---------------------------------------------------------------------------

interface PayloadModalProps {
  eventId: string;
  onClose: () => void;
}

function PayloadModal({ eventId, onClose }: PayloadModalProps) {
  const t = useT('components.paymentEventsTimeline');
  const tCommon = useT('common');
  const [payload, setPayload] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Fetch on mount
  useEffect(() => {
    apiGet<{ event: PaymentEventPayload }>(`/api/v1/payments/events/${eventId}/payload`)
      .then(({ data, error }) => {
        if (error || !data?.event) {
          setErr(error?.message ?? t('payloadLoadFailed'));
        } else {
          setPayload(data.event.providerPayload);
        }
      })
      .catch(e => setErr(e instanceof Error ? e.message : t('unknownError')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  return (
    <Modal isOpen onClose={onClose} title={t('rawPayloadModalTitle')} size="lg">
      {loading && (
        <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
          <svg
            className="me-2 h-4 w-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {tCommon('loading')}
        </div>
      )}
      {err && !loading && <p className="py-6 text-center text-sm text-destructive-ink">{err}</p>}
      {!loading && !err && (
        <pre className="mt-2 max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs text-foreground font-mono whitespace-pre-wrap break-all">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Single timeline row
// ---------------------------------------------------------------------------

interface EventRowProps {
  event: PaymentEvent;
  isLast: boolean;
  isSuperAdmin: boolean;
}

function EventRow({ event, isLast, isSuperAdmin }: EventRowProps) {
  const t = useT('components.paymentEventsTimeline');
  const [showPayload, setShowPayload] = useState(false);
  const label = getLabel(
    key => t(key as Parameters<typeof t>[0]),
    key => t.has(key as Parameters<typeof t.has>[0]),
    event.eventType
  );
  const iconVariant = getIconVariant(event.eventType);
  const trim = walletTrimOf(event.details);
  const detailsText = trim
    ? t('walletTrimmed', {
        planned: minorToDecimalString(trim.planned),
        credited: minorToDecimalString(trim.credited),
        short: minorToDecimalString(trim.short),
      })
    : formatDetails(event.details);

  return (
    <li className="relative flex gap-3">
      {/* Vertical connector line — hidden on last item */}
      {!isLast && <div className="absolute left-4 top-8 bottom-0 w-px bg-border" aria-hidden />}

      <EventIcon variant={iconVariant} />

      <div className="min-w-0 flex-1 pb-5">
        {/* Labels row */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>

        {/* Meta row — chips + time */}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {event.fromStatus && event.toStatus && (
            <StatusChip from={event.fromStatus} to={event.toStatus} />
          )}
          {event.provider && <ProviderBadge provider={event.provider} />}

          {/* Relative time with absolute on hover */}
          <span
            className="text-xs text-muted-foreground cursor-default"
            title={absoluteTime(event.occurredAt)}
          >
            {relativeTime(event.occurredAt)}
          </span>
        </div>

        {/* details note if present */}
        {detailsText && <p className="mt-1 text-xs text-muted-foreground">{detailsText}</p>}

        {/* Super-admin raw payload button */}
        {isSuperAdmin && (
          <>
            <Button
              variant="link"
              size="sm"
              type="button"
              onClick={() => setShowPayload(true)}
              className="mt-2 gap-1.5"
            >
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              {t('viewRawPayload')}
            </Button>
            {showPayload && (
              <PayloadModal eventId={event.id} onClose={() => setShowPayload(false)} />
            )}
          </>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface PaymentEventsTimelineProps {
  paymentId: string;
  userRole?: 'super_admin' | 'store_admin' | 'customer' | 'staff';
}

export function PaymentEventsTimeline({ paymentId, userRole }: PaymentEventsTimelineProps) {
  const t = useT('components.paymentEventsTimeline');
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const isSuperAdmin = userRole === 'super_admin';

  const fetchEvents = useCallback(async () => {
    if (fetched) return;
    setLoading(true);
    setErr(null);
    try {
      const { data, error } = await apiGet<{ events: PaymentEvent[]; total: number }>(
        `/api/v1/payments/${paymentId}/events`
      );
      if (error || !data) {
        setErr('load-failed');
      } else {
        setEvents(data.events);
        setCount(data.total ?? data.events.length);
        setFetched(true);
      }
    } catch {
      setErr('load-failed');
    } finally {
      setLoading(false);
    }
  }, [paymentId, fetched]);

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next) await fetchEvents();
  }, [expanded, fetchEvents]);

  const countLabel = count !== null ? ` (${count})` : '';

  return (
    // Super-admin gets the dashed-primary-border panel treatment; store_admin
    // gets a lighter treatment to stay visually subordinate to PaymentCard.
    <div
      className={`mt-3 rounded-xl border p-3 ${
        isSuperAdmin
          ? 'border-dashed border-primary/40 bg-primary/5'
          : 'border-border bg-background'
      }`}
    >
      {/* Toggle button */}
      <button
        data-ui="row"
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 text-sm font-medium text-primary hover:opacity-80 transition-opacity cursor-pointer"
        aria-expanded={expanded}
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span>
          {t('toggleLabel')}
          {countLabel}
          {isSuperAdmin && (
            <span className="ms-1.5 text-xs font-normal text-muted-foreground">
              {t('superAdminBadge')}
            </span>
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-4">
          {/* Loading spinner */}
          {loading && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <svg
                className="h-4 w-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {t('loadingEvents')}
            </div>
          )}

          {/* Error state — non-breaking; order detail still usable */}
          {err && !loading && (
            <p className="py-2 text-xs text-destructive-ink">{t('couldNotLoadEvents')}</p>
          )}

          {/* Empty state */}
          {!loading && !err && events.length === 0 && (
            <div className="py-3 text-center">
              <p className="text-sm text-muted-foreground">{t('noEventsYet')}</p>
            </div>
          )}

          {/* Timeline list — newest first (API already returns newest first) */}
          {!loading && !err && events.length > 0 && (
            <ul className="space-y-0 pt-1" role="list">
              {events.map((event, idx) => (
                <EventRow
                  key={event.id}
                  event={event}
                  isLast={idx === events.length - 1}
                  isSuperAdmin={isSuperAdmin}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
