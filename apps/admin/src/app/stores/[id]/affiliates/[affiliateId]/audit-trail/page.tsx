'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet } from '../../../../../../lib/api';
import { formatPrice, intlLocaleForUi } from '@/lib/format';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';

// ---------------------------------------------------------------------------
// Types — shape returned by GET /affiliates/:id/audit-trail
// (reads the actual affiliate_events append-only table)
// ---------------------------------------------------------------------------

interface AffiliateAuditEvent {
  id: string;
  affiliateId: string;
  storeId: string;
  eventType: string; // approve | reject | suspend | commission_recorded | payout_initiated | payout_completed | created
  fromStatus: string | null;
  toStatus: string | null;
  triggeredByUserId: string | null;
  details: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

interface AffiliateInfo {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Event type → locale-aware label (falls back to a de-slugged event type for
// anything not in the affiliates.auditTrail.eventTypes catalog).
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  'created',
  'approve',
  'reject',
  'suspend',
  'reactivate',
  'commission_recorded',
  'payout_initiated',
  'payout_completed',
  'payout_failed',
]);

function getLabel(t: ReturnType<typeof useT>, eventType: string): string {
  if (KNOWN_EVENT_TYPES.has(eventType)) {
    return t(`eventTypes.${eventType}`);
  }
  return eventType.replace(/_/g, ' ');
}

type IconVariant = 'success' | 'reject' | 'money' | 'default';

function getIconVariant(eventType: string): IconVariant {
  if (['approve', 'payout_completed', 'reactivate'].includes(eventType)) return 'success';
  if (['reject', 'payout_failed', 'suspend'].includes(eventType)) return 'reject';
  if (['commission_recorded', 'payout_initiated'].includes(eventType)) return 'money';
  return 'default';
}

function EventIcon({ variant }: { variant: IconVariant }) {
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
  if (variant === 'money') {
    return (
      <span className={`${base} bg-info/10 text-info-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </span>
    );
  }
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
// Status transition chip
// ---------------------------------------------------------------------------

function StatusTransitionChip({ from, to }: { from: string; to: string }) {
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
// Page component
// ---------------------------------------------------------------------------

export default function AffiliateAuditTrailPage() {
  const t = useT('affiliates.auditTrail');
  const tTabs = useT('affiliates.tabs');
  const tCommon = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const affiliateId = params?.affiliateId as string;

  const [events, setEvents] = useState<AffiliateAuditEvent[]>([]);
  const [affiliate, setAffiliate] = useState<AffiliateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch from the /audit-trail endpoint which reads the actual affiliate_events table
      const [eventsRes, affiliateRes] = await Promise.all([
        apiGet<{ events: AffiliateAuditEvent[] }>(
          `/api/v1/stores/${storeId}/affiliates/${affiliateId}/audit-trail`
        ),
        apiGet<{ affiliate: AffiliateInfo }>(`/api/v1/stores/${storeId}/affiliates/${affiliateId}`),
      ]);
      if (eventsRes.data) setEvents(eventsRes.data.events ?? []);
      if (affiliateRes.data) setAffiliate(affiliateRes.data.affiliate ?? null);
    } catch {
      setError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [storeId, affiliateId, t]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={affiliate ? t('titleWithName', { name: affiliate.name }) : t('titleFallback')}
      subtitle={tTabs('affiliates')}
    >
      <div className="mx-auto max-w-3xl px-4 pb-12 pt-4 sm:px-6">
        {/* Back link */}
        <Link
          href={`/stores/${storeId}/affiliates`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          {t('backToAffiliates')}
        </Link>

        {/* Affiliate info card */}
        {affiliate && (
          <div className="mb-6 rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-foreground">{affiliate.name}</p>
                <p className="text-sm text-muted-foreground">{affiliate.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <code className="rounded-md bg-muted px-2 py-1 text-sm font-mono">
                  {affiliate.referralCode}
                </code>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-foreground capitalize">
                  {affiliate.status}
                </span>
                <Link
                  href={`/stores/${storeId}/affiliates/${affiliateId}/events`}
                  className="text-xs text-primary hover:underline"
                >
                  {t('referralsAndPayouts')} →
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Page heading */}
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.rich('description', {
              code: chunks => <code className="text-xs bg-muted px-1 rounded-md">{chunks}</code>,
            })}
          </p>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive-ink">{error}</p>
            <Button
              variant="outline"
              size="md"
              className="mt-3 border-destructive text-destructive-ink"
              type="button"
              onClick={fetchEvents}
            >
              {tCommon('retry')}
            </Button>
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <p className="text-muted-foreground">{t('noEvents')}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t('noEventsHint')}</p>
          </div>
        )}

        {!loading && !error && events.length > 0 && (
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {t('title')}
              </h3>
              <span className="text-xs text-muted-foreground">
                {t('eventsCount', { count: events.length })}
              </span>
            </div>
            <ol className="px-5 py-4 space-y-0">
              {events.map((event, idx) => {
                const label = getLabel(t, event.eventType);
                const iconVariant = getIconVariant(event.eventType);
                return (
                  <li key={event.id} className="relative flex gap-3 pb-6 last:pb-0">
                    {idx < events.length - 1 && (
                      <span
                        className="absolute start-4 top-8 h-[calc(100%-2rem)] w-px bg-border"
                        aria-hidden
                      />
                    )}
                    <EventIcon variant={iconVariant} />
                    <div className="flex-1 min-w-0 pt-1">
                      <span className="text-sm font-medium text-foreground">{label}</span>

                      {/* Status transition chip */}
                      {event.fromStatus && event.toStatus && (
                        <div className="mt-1">
                          <StatusTransitionChip from={event.fromStatus} to={event.toStatus} />
                        </div>
                      )}

                      {/* Details */}
                      {event.details && Object.keys(event.details).length > 0 && (
                        <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                          {!!event.details.reason && (
                            <p>{t('reasonLabel', { reason: String(event.details.reason) })}</p>
                          )}
                          {!!event.details.notes && <p>{String(event.details.notes)}</p>}
                          {event.details.commissionAmount !== undefined && (
                            <p>
                              {t('commissionLabel')}{' '}
                              <span className="font-medium text-success-ink">
                                +{formatPrice(Number(event.details.commissionAmount))}
                              </span>
                            </p>
                          )}
                          {event.details.payoutAmount !== undefined && (
                            <p>
                              {t('payoutLabelText')}{' '}
                              <span className="font-medium">
                                {formatPrice(Number(event.details.payoutAmount))}
                              </span>
                            </p>
                          )}
                        </div>
                      )}

                      {/* Timestamp */}
                      <time
                        dateTime={event.occurredAt}
                        className="mt-1 block text-xs text-muted-foreground"
                        title={new Date(event.occurredAt).toLocaleString(intlLocaleForUi('en-GB'), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      >
                        {new Date(event.occurredAt).toLocaleString(intlLocaleForUi('en-GB'), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
