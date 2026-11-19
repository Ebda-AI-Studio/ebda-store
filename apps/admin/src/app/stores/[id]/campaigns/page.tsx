'use client';

/**
 * /stores/[id]/campaigns — email campaign list (D2).
 *
 * Feature-gated via `useRequireFeature('email_campaigns')` — the key is in
 * the Growth + Business baselines (not Basic), so on Basic every route in
 * `campaign.routes.ts` 403s (`FEATURE_DISABLED`) until the store upgrades or a
 * super-admin turns it on; the page renders the upsell gate ("Available on the
 * Growth plan") instead, same pattern as `bundles/page.tsx`.
 *
 * Audience is always "active newsletter subscribers who opted in" — there is
 * no other source (Ruling EC-1, docs/plans/done/2026-09-25-email-campaigns.md) —
 * so the header states that plainly rather than implying "customers".
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { formatDateTime } from '@/lib/format';
import { AdminLayout } from '../../../../components/AdminLayout';
import { DataTable } from '../../../../components/mobile/DataTable';
import { OrderStatusBadge } from '../../../../components/OrderStatusBadge';
import { apiGet, apiPost } from '../../../../lib/api';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { Button } from '@/components/ui/Button';

type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';

interface CampaignListItem {
  id: string;
  name: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AudienceInfo {
  count: number;
  dailyCap: number;
  sentLast24h: number;
  remainingToday: number;
}

// Colors reused for the status badge — subtle, distinct per status, dark-mode
// aware (same shape OrderStatusBadge already renders for orders/returns).
// Plain `as const` (no Record<K,V> annotation) mirrors returns/types.ts'
// RETURN_COLORS — passed straight into `colorMap`'s `Record<string, ...>`.
const CAMPAIGN_STATUS_COLORS = {
  draft: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  scheduled: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  sending: { bg: 'bg-warning/10', text: 'text-warning-ink', dot: 'bg-warning' },
  sent: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  failed: { bg: 'bg-destructive/5', text: 'text-destructive-ink', dot: 'bg-destructive' },
} as const;

// Known lastError codes the send job can leave behind (campaign-send.ts) —
// translated when recognized (shared `campaigns.errors` namespace, also used
// by the editor/detail page), shown raw otherwise so a new backend code is
// still visible rather than silently swallowed.
const LAST_ERROR_KEYS: Record<string, string> = {
  DAILY_CAP_EXCEEDED: 'dailyCapExceeded',
  EMPTY_AUDIENCE: 'emptyAudience',
  SEND_JOB_FAILED: 'sendJobFailed',
  ALL_RECIPIENTS_FAILED: 'allRecipientsFailed',
};

export default function CampaignsListPage() {
  const { gate } = useRequireFeature('email_campaigns');

  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const locale = useLocale();
  const isRtl = locale === 'ar';
  const t = useT('campaigns.list');
  const tErr = useT('campaigns.errors');

  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<AudienceInfo | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchAudience = useCallback(async () => {
    const { data } = await apiGet<AudienceInfo>(`/api/v1/stores/${storeId}/campaigns/audience`);
    if (data) setAudience(data);
  }, [storeId]);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await apiGet<{
      campaigns: CampaignListItem[];
      nextCursor: string | null;
    }>(`/api/v1/stores/${storeId}/campaigns`);
    if (err) {
      setError(err.message || t('loadFailed'));
    } else if (data) {
      setCampaigns(data.campaigns);
      setNextCursor(data.nextCursor);
    }
    setLoading(false);
  }, [storeId, t]);

  useEffect(() => {
    if (!storeId) return;
    void fetchCampaigns();
    void fetchAudience();
  }, [storeId, fetchCampaigns, fetchAudience]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const { data, error: err } = await apiGet<{
      campaigns: CampaignListItem[];
      nextCursor: string | null;
    }>(`/api/v1/stores/${storeId}/campaigns?cursor=${nextCursor}`);
    if (!err && data) {
      setCampaigns(prev => [...prev, ...data.campaigns]);
      setNextCursor(data.nextCursor);
    }
    setLoadingMore(false);
  };

  const createCampaign = async () => {
    setCreating(true);
    setError(null);
    const { data, error: err } = await apiPost<{ campaign: { id: string } }>(
      `/api/v1/stores/${storeId}/campaigns`,
      { name: t('untitledCampaign') }
    );
    setCreating(false);
    if (err) {
      setError(err.message || t('createFailed'));
      return;
    }
    if (data?.campaign) {
      router.push(`/stores/${storeId}/campaigns/${data.campaign.id}`);
    }
  };

  const dateCell = (c: CampaignListItem) => {
    if (c.sentAt) return t('dateSent', { date: formatDateTime(c.sentAt) });
    if (c.scheduledAt && c.status === 'scheduled') {
      return t('dateScheduled', { date: formatDateTime(c.scheduledAt) });
    }
    return t('dateCreated', { date: formatDateTime(c.createdAt) });
  };

  const lastErrorText = (code: string | null) => {
    if (!code) return null;
    const key = LAST_ERROR_KEYS[code];
    return key ? tErr(key) : code;
  };

  if (gate) return gate;

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      mode="store_admin"
      storeId={storeId}
      actions={
        <Button
          variant="default"
          size="md"
          type="button"
          onClick={() => void createCampaign()}
          disabled={creating}
        >
          {creating ? t('creating') : t('newCampaign')}
        </Button>
      }
    >
      <div className="mx-auto max-w-5xl px-4 py-6">
        {audience && (
          <div className="mb-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="font-medium text-foreground">
              {t('audienceCount', { count: audience.count })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('audienceExplanation')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('audienceRemaining', {
                remaining: audience.remainingToday,
                cap: audience.dailyCap,
              })}
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          // Card mode below md (shared DataTable), the real table from md up (UX:M-2).
          <DataTable<CampaignListItem>
            ariaLabel={t('title')}
            rows={campaigns}
            rowKey={c => c.id}
            columns={[
              {
                header: t('colName'),
                primaryOnMobile: true,
                cell: c => (
                  <>
                    <Button
                      variant="link"
                      size="sm"
                      className="text-start"
                      type="button"
                      onClick={() => router.push(`/stores/${storeId}/campaigns/${c.id}`)}
                    >
                      {c.name}
                    </Button>
                    {lastErrorText(c.lastError) && (
                      <p className="mt-0.5 text-xs text-destructive-ink">
                        {lastErrorText(c.lastError)}
                      </p>
                    )}
                  </>
                ),
              },
              {
                header: t('colStatus'),
                mobileBadge: true,
                cell: c => (
                  <OrderStatusBadge
                    status={c.status}
                    namespace="campaigns.status"
                    colorMap={CAMPAIGN_STATUS_COLORS}
                  />
                ),
              },
              {
                header: t('colRecipients'),
                cell: c => <span className="tabular-nums">{c.recipientCount}</span>,
              },
              {
                header: t('colSent'),
                cell: c => <span className="tabular-nums">{c.sentCount}</span>,
              },
              {
                header: t('colFailed'),
                cell: c => <span className="tabular-nums">{c.failedCount}</span>,
              },
              {
                header: t('colDate'),
                cell: c => (
                  <span className="text-muted-foreground" dir={isRtl ? 'rtl' : 'ltr'}>
                    {dateCell(c)}
                  </span>
                ),
              },
            ]}
          />
        )}

        {nextCursor && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="md"
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? t('loading') : t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
