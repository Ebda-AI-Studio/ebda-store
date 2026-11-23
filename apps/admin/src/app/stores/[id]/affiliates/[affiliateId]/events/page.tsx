'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet } from '../../../../../../lib/api';
import { formatPrice, intlLocaleForUi } from '@/lib/format';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import {} from '@ebda/shared';
import { SignedNumber } from '@ebda/ui';

interface AffiliateEvent {
  id: string;
  at: string;
  kind: string;
  details: {
    referralCode?: string;
    orderId?: string;
    orderNumber?: string;
    orderTotal?: number;
    commissionAmount?: number;
    status?: string;
    amount?: number;
    method?: string;
    notes?: string;
  };
}

interface AffiliateInfo {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  status: string;
}

// Bilingual EN/AR labels for event kinds
const EVENT_LABELS: Record<string, { en: string; ar: string; color: string }> = {
  'referral.clicked': {
    en: 'Referral link clicked',
    ar: 'نقر على رابط الإحالة',
    color: 'bg-muted text-foreground',
  },
  'referral.converted': {
    en: 'Referral converted (sale)',
    ar: 'تحويل الإحالة (بيع)',
    color: 'bg-success/10 text-success-ink',
  },
  'payout.initiated': {
    en: 'Payout initiated',
    ar: 'بدء الدفع',
    color: 'bg-info/10 text-info-ink',
  },
  'payout.completed': {
    en: 'Payout completed',
    ar: 'اكتمل الدفع',
    color: 'bg-success/10 text-success-ink',
  },
  'payout.pending': {
    en: 'Payout pending',
    ar: 'دفع معلق',
    color: 'bg-warning/10 text-warning-ink',
  },
  'payout.failed': {
    en: 'Payout failed',
    ar: 'فشل الدفع',
    color: 'bg-destructive/10 text-destructive-ink',
  },
};

function eventLabel(kind: string): string {
  return EVENT_LABELS[kind]?.en ?? kind.replace(/[._]/g, ' ');
}

function eventBadgeClass(kind: string): string {
  return EVENT_LABELS[kind]?.color ?? 'bg-muted text-foreground';
}

type IconType = 'conversion' | 'payout' | 'click' | 'fail';

function getIconType(kind: string): IconType {
  if (kind === 'referral.converted') return 'conversion';
  if (kind.startsWith('payout.completed')) return 'payout';
  if (kind.includes('fail')) return 'fail';
  return 'click';
}

function EventIcon({ type }: { type: IconType }) {
  const base = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full';
  if (type === 'conversion')
    return (
      <span className={`${base} bg-success/10 text-success-ink`}>
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
  if (type === 'payout')
    return (
      <span className={`${base} bg-info/10 text-info-ink`}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
          />
        </svg>
      </span>
    );
  if (type === 'fail')
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
  return (
    <span className={`${base} bg-muted text-muted-foreground`}>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5"
        />
      </svg>
    </span>
  );
}

export default function AffiliateEventsPage() {
  const t = useT('affiliates');
  const tc = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const affiliateId = params?.affiliateId as string;

  const [events, setEvents] = useState<AffiliateEvent[]>([]);
  const [affiliate, setAffiliate] = useState<AffiliateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiGet<{ events: AffiliateEvent[]; affiliate: AffiliateInfo }>(
        `/api/v1/stores/${storeId}/affiliates/${affiliateId}/events`
      );
      if (data) {
        setEvents(data.events ?? []);
        setAffiliate(data.affiliate ?? null);
      }
    } catch {
      setError(t('eventsLoadFailed'));
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
      title={affiliate ? t('eventsTitle', { name: affiliate.name }) : t('eventsTitleFallback')}
      subtitle={t('subtitle')}
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

        {affiliate && (
          <div className="mb-6 rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-foreground">{affiliate.name}</p>
                <p className="text-sm text-muted-foreground">{affiliate.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
                  {affiliate.referralCode}
                </code>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-foreground capitalize">
                  {affiliate.status}
                </span>
                <Link
                  href={`/stores/${storeId}/affiliates/${affiliateId}/audit-trail`}
                  className="text-xs text-primary hover:underline"
                >
                  {t('auditTrail2')}
                </Link>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        )}

        {error && !loading && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive-ink">{error}</p>
            <Button
              variant="outline"
              size="md"
              className="mt-3 border-destructive text-destructive-ink"
              type="button"
              onClick={fetchEvents}
            >
              {tc('retry')}
            </Button>
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-12 text-center">
            <p className="text-muted-foreground">{t('noEventsYet')}</p>
          </div>
        )}

        {!loading && !error && events.length > 0 && (
          <div className="rounded-2xl border border-border bg-card">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {t('eventHistory')}
              </h2>
            </div>
            <ol className="px-5 py-4 space-y-0">
              {events.map((event, idx) => (
                <li key={event.id} className="relative flex gap-3 pb-6 last:pb-0">
                  {idx < events.length - 1 && (
                    <span
                      className="absolute start-4 top-8 h-[calc(100%-2rem)] w-px bg-border"
                      aria-hidden
                    />
                  )}
                  <EventIcon type={getIconType(event.kind)} />
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {eventLabel(event.kind)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${eventBadgeClass(event.kind)}`}
                      >
                        {event.kind}
                      </span>
                    </div>

                    {/* Event-specific details */}
                    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {event.details.orderNumber && (
                        <p>
                          {t('orderLabel')}{' '}
                          <Link
                            href={`/stores/${storeId}/orders/${event.details.orderId}`}
                            className="text-primary hover:underline"
                          >
                            {event.details.orderNumber}
                          </Link>
                          {event.details.orderTotal !== undefined && (
                            <span className="ms-1">({formatPrice(event.details.orderTotal)})</span>
                          )}
                        </p>
                      )}
                      {event.details.commissionAmount !== undefined && (
                        <p>
                          {t('commissionLabel')}{' '}
                          <span className="font-medium text-success-ink">
                            <SignedNumber
                              value={event.details.commissionAmount}
                              plus
                              format={abs => formatPrice(abs)}
                            />
                          </span>
                        </p>
                      )}
                      {event.details.amount !== undefined && (
                        <p>
                          {t('amountLabel')}{' '}
                          <span className="font-medium text-foreground">
                            {formatPrice(event.details.amount)}
                          </span>
                          {event.details.method && (
                            <span className="ms-1">
                              {t('via')} {event.details.method}
                            </span>
                          )}
                        </p>
                      )}
                      {event.details.notes && <p>{event.details.notes}</p>}
                    </div>

                    <time dateTime={event.at} className="mt-1 block text-xs text-muted-foreground">
                      {new Date(event.at).toLocaleString(intlLocaleForUi(), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
