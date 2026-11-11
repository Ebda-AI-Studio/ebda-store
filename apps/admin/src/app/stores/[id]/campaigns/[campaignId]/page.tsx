'use client';

/**
 * /stores/[id]/campaigns/[campaignId] — one page, two modes (D2 plan,
 * docs/plans/2026-09-25-email-campaigns.md):
 *
 *   - `status === 'draft'` → EDITOR: bilingual subject/body, locale
 *     strategy, sanitized preview, audience count, AI draft, send test to
 *     me, send now / schedule behind an in-page confirm.
 *   - anything else → DETAIL: read-only summary + per-recipient table +
 *     cancel (scheduled/sending) + delete (cancelled/failed), auto-refreshed
 *     every 10s while the send job is in flight.
 *
 * Feature-gated like the list page (`useRequireFeature('email_campaigns')`).
 * Sanitization happens server-side on save AND again at send
 * (`sanitizeNewsletterHtml`) — the preview iframe below is `sandbox=""` +
 * `srcDoc`, never `dangerouslySetInnerHTML`, same as `newsletter/page.tsx`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import {
  CAMPAIGN_BODY_MAX,
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_SUBJECT_MAX,
  isCampaignSendable,
  type CampaignLocaleStrategy,
  type CampaignRecipientStatusValue,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { formatDateTime } from '@/lib/format';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { apiDelete, apiGet, apiPost, apiPut } from '../../../../../lib/api';
import { useRequireFeature } from '../../../../../hooks/useRequireFeature';
import { CAMPAIGN_ERROR_KEYS } from '../_components/campaignErrorKeys';
import { ConfirmDialog } from '../_components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';

interface CampaignDetail {
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
  subject: string;
  subjectAr: string | null;
  bodyHtml: string;
  bodyHtmlAr: string | null;
  localeStrategy: CampaignLocaleStrategy;
}

interface StatusCounts {
  queued: number;
  sent: number;
  failed: number;
  bounced: number;
  unsubscribed: number;
}

interface Recipient {
  id: string;
  email: string;
  locale: string;
  status: CampaignRecipientStatusValue;
  error: string | null;
  sentAt: string | null;
  unsubscribedAt: string | null;
  customerId: string | null;
}

interface AudienceInfo {
  count: number;
  dailyCap: number;
  sentLast24h: number;
  remainingToday: number;
}

interface FormState {
  name: string;
  subject: string;
  subjectAr: string;
  bodyHtml: string;
  bodyHtmlAr: string;
  localeStrategy: CampaignLocaleStrategy;
}

// Plain `as const` objects (no Record<K,V> annotation) mirror
// returns/_components/types.ts's RETURN_COLORS — passed straight into
// OrderStatusBadge's `colorMap: Record<string, StatusStyle>` prop.
const CAMPAIGN_STATUS_COLORS = {
  draft: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  scheduled: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  sending: { bg: 'bg-warning/10', text: 'text-warning-ink', dot: 'bg-warning' },
  sent: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  failed: { bg: 'bg-destructive/5', text: 'text-destructive-ink', dot: 'bg-destructive' },
} as const;

const RECIPIENT_STATUS_COLORS = {
  queued: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  sent: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  failed: { bg: 'bg-destructive/5', text: 'text-destructive-ink', dot: 'bg-destructive' },
  bounced: { bg: 'bg-warning/10', text: 'text-warning-ink', dot: 'bg-warning' },
  unsubscribed: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
} as const;

const ERROR_KEYS = CAMPAIGN_ERROR_KEYS;

function formFromCampaign(c: CampaignDetail): FormState {
  return {
    name: c.name,
    subject: c.subject,
    subjectAr: c.subjectAr ?? '',
    bodyHtml: c.bodyHtml,
    bodyHtmlAr: c.bodyHtmlAr ?? '',
    localeStrategy: c.localeStrategy,
  };
}

function snapshotOf(f: FormState): string {
  return JSON.stringify(f);
}

type PendingAction = 'sendNow' | 'schedule' | 'delete' | 'cancel' | null;

export default function CampaignDetailPage() {
  const { gate } = useRequireFeature('email_campaigns');

  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const campaignId = params?.campaignId as string;
  const locale = useLocale();
  const isRtl = locale === 'ar';
  const t = useT('campaigns.editor');
  const tD = useT('campaigns.detail');
  const tErr = useT('campaigns.errors');
  const tRecipientStatus = useT('campaigns.recipientStatus');
  const tc = useT('common');

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [statusCounts, setStatusCounts] = useState<StatusCounts | null>(null);
  // DELETE refuses a campaign with any recipient `sentAt` — send history is
  // permanent (#1951). The API reports that exact predicate; an older API
  // without the field falls back to the campaign's own sent counter.
  const [hasSendHistory, setHasSendHistory] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [audience, setAudience] = useState<AudienceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ sentTo: string; locales: string[] } | null>(null);
  const [sendSubmitting, setSendSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [scheduleInput, setScheduleInput] = useState('');
  const [previewEn, setPreviewEn] = useState(false);
  const [previewAr, setPreviewAr] = useState(false);
  const [showAiBox, setShowAiBox] = useState(false);
  const [aiBrief, setAiBrief] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Recipients (detail mode only)
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientsCursor, setRecipientsCursor] = useState<string | null>(null);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsLoadingMore, setRecipientsLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'' | CampaignRecipientStatusValue>('');

  const mapError = useCallback(
    (code: string | undefined, message: string) => {
      if (code && ERROR_KEYS[code]) return tErr(ERROR_KEYS[code]);
      return message;
    },
    [tErr]
  );

  const fetchCampaign = useCallback(async () => {
    const { data, error: err } = await apiGet<{
      campaign: CampaignDetail;
      statusCounts: StatusCounts;
      hasSendHistory?: boolean;
    }>(`/api/v1/stores/${storeId}/campaigns/${campaignId}`);
    if (err) {
      setLoadError(err.message || tD('loadFailed'));
      return;
    }
    if (data) {
      setCampaign(data.campaign);
      setStatusCounts(data.statusCounts);
      setHasSendHistory(data.hasSendHistory ?? data.campaign.sentCount > 0);
      const f = formFromCampaign(data.campaign);
      setForm(f);
      setSavedSnapshot(snapshotOf(f));
    }
  }, [storeId, campaignId, tD]);

  const fetchAudience = useCallback(async () => {
    const { data } = await apiGet<AudienceInfo>(`/api/v1/stores/${storeId}/campaigns/audience`);
    if (data) setAudience(data);
  }, [storeId]);

  const fetchRecipients = useCallback(
    async (opts: {
      reset: boolean;
      cursor?: string | null;
      status: '' | CampaignRecipientStatusValue;
    }) => {
      if (opts.reset) setRecipientsLoading(true);
      else setRecipientsLoadingMore(true);
      const qs = new URLSearchParams();
      if (opts.status) qs.set('status', opts.status);
      if (!opts.reset && opts.cursor) qs.set('cursor', opts.cursor);
      const { data } = await apiGet<{ recipients: Recipient[]; nextCursor: string | null }>(
        `/api/v1/stores/${storeId}/campaigns/${campaignId}/recipients?${qs.toString()}`
      );
      if (data) {
        setRecipients(prev => (opts.reset ? data.recipients : [...prev, ...data.recipients]));
        setRecipientsCursor(data.nextCursor);
      }
      setRecipientsLoading(false);
      setRecipientsLoadingMore(false);
    },
    [storeId, campaignId]
  );

  useEffect(() => {
    if (!storeId || !campaignId) return;
    (async () => {
      setLoading(true);
      await Promise.all([fetchCampaign(), fetchAudience()]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, campaignId]);

  // Recipients load once the campaign is known to be non-draft, and again
  // whenever the status filter changes.
  useEffect(() => {
    if (!campaign || campaign.status === 'draft') return;
    void fetchRecipients({ reset: true, status: statusFilter });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.status, statusFilter]);

  // Auto-refresh the summary every 10s while the send job may still be
  // moving (scheduled → sending → sent/failed). Deliberately keyed on
  // `campaign?.status` only — re-arming the interval on every other field
  // change (recipientCount, etc.) would restart the 10s clock on each poll.
  useEffect(() => {
    if (!campaign) return;
    if (campaign.status !== 'scheduled' && campaign.status !== 'sending') return;
    const id = setInterval(() => {
      void fetchCampaign();
    }, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.status, fetchCampaign]);

  const isDirty = useMemo(
    () => (form ? snapshotOf(form) !== savedSnapshot : false),
    [form, savedSnapshot]
  );

  const sendable = useMemo(
    () =>
      form
        ? isCampaignSendable({
            subject: form.subject,
            subjectAr: form.subjectAr,
            bodyHtml: form.bodyHtml,
            bodyHtmlAr: form.bodyHtmlAr,
          })
        : false,
    [form]
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!form) return false;
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      subject: form.subject.trim(),
      subjectAr: form.subjectAr.trim() || null,
      bodyHtml: form.bodyHtml,
      bodyHtmlAr: form.bodyHtmlAr.trim() || null,
      localeStrategy: form.localeStrategy,
      audience: { source: 'newsletter' as const },
    };
    const { data, error: err } = await apiPut<{ campaign: CampaignDetail }>(
      `/api/v1/stores/${storeId}/campaigns/${campaignId}`,
      body
    );
    setSaving(false);
    if (err) {
      setError(mapError(err.code, err.message || t('saveFailed')));
      return false;
    }
    if (data?.campaign) {
      setCampaign(data.campaign);
      setSavedSnapshot(snapshotOf(formFromCampaign(data.campaign)));
    }
    return true;
  }, [form, storeId, campaignId, mapError, t]);

  const submitAiDraft = async () => {
    setAiLoading(true);
    setAiError(null);
    const { data, error: err } = await apiPost<{
      suggestion: { subject: string; subjectAr: string; bodyHtml: string; bodyHtmlAr: string };
      cached: boolean;
    }>(`/api/v1/stores/${storeId}/campaigns/ai-draft`, { brief: aiBrief.trim() });
    setAiLoading(false);
    if (err) {
      setAiError(err.message || t('aiDraftFailed'));
      return;
    }
    if (data?.suggestion) {
      setForm(f =>
        f
          ? {
              ...f,
              subject: data.suggestion.subject,
              subjectAr: data.suggestion.subjectAr,
              bodyHtml: data.suggestion.bodyHtml,
              bodyHtmlAr: data.suggestion.bodyHtmlAr,
            }
          : f
      );
      setShowAiBox(false);
      setAiBrief('');
    }
  };

  const sendTest = async () => {
    setError(null);
    setTestResult(null);
    if (isDirty) {
      const ok = await save();
      if (!ok) return;
    }
    setTestSending(true);
    const { data, error: err } = await apiPost<{ sentTo: string; locales: string[] }>(
      `/api/v1/stores/${storeId}/campaigns/${campaignId}/test`
    );
    setTestSending(false);
    if (err) {
      setError(mapError(err.code, err.message || t('testFailed')));
      return;
    }
    if (data) setTestResult(data);
  };

  const confirmSend = async () => {
    setError(null);
    if (isDirty) {
      const ok = await save();
      if (!ok) {
        setPendingAction(null);
        return;
      }
    }
    setSendSubmitting(true);
    const scheduledAtIso =
      pendingAction === 'schedule' && scheduleInput
        ? new Date(scheduleInput).toISOString()
        : undefined;
    const { data, error: err } = await apiPost<{
      status: string;
      scheduledAt: string;
      audience: number;
    }>(
      `/api/v1/stores/${storeId}/campaigns/${campaignId}/send`,
      scheduledAtIso ? { scheduledAt: scheduledAtIso } : {}
    );
    setSendSubmitting(false);
    setPendingAction(null);
    if (err) {
      setError(mapError(err.code, err.message || t('sendFailed')));
      return;
    }
    if (data) await fetchCampaign();
  };

  const confirmDelete = async () => {
    setDeleting(true);
    const { error: err } = await apiDelete(`/api/v1/stores/${storeId}/campaigns/${campaignId}`);
    setDeleting(false);
    setPendingAction(null);
    if (err) {
      setError(mapError(err.code, err.message || t('deleteFailed')));
      return;
    }
    router.push(`/stores/${storeId}/campaigns`);
  };

  const confirmCancel = async () => {
    setCancelling(true);
    const { error: err } = await apiPost(
      `/api/v1/stores/${storeId}/campaigns/${campaignId}/cancel`
    );
    setCancelling(false);
    setPendingAction(null);
    if (err) {
      setError(mapError(err.code, err.message || tD('cancelFailed')));
      return;
    }
    await fetchCampaign();
  };

  if (gate) return gate;

  const backLink = (
    <Link href={`/stores/${storeId}/campaigns`} className="text-sm text-primary hover:underline">
      {isRtl ? `${tc('back')} ←` : `← ${tc('back')}`}
    </Link>
  );

  if (loading || !form) {
    return (
      <AdminLayout title={t('loadingTitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-3xl px-4 py-6">
          {backLink}
          <p className="mt-6 py-12 text-center text-sm text-muted-foreground">{tc('loading')}</p>
        </div>
      </AdminLayout>
    );
  }

  if (loadError || !campaign) {
    return (
      <AdminLayout title={t('loadingTitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-3xl px-4 py-6">
          {backLink}
          <div
            role="alert"
            className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {loadError || tD('loadFailed')}
          </div>
        </div>
      </AdminLayout>
    );
  }

  const isDraft = campaign.status === 'draft';

  return (
    <AdminLayout
      title={campaign.name}
      subtitle={isDraft ? t('subtitleEditor') : tD('subtitleDetail')}
      mode="store_admin"
      storeId={storeId}
    >
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-4">
        <div className="mb-4 flex items-center justify-between">
          {backLink}
          <OrderStatusBadge
            status={campaign.status}
            namespace="campaigns.status"
            colorMap={CAMPAIGN_STATUS_COLORS}
          />
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}

        {isDraft ? (
          <div className="space-y-5">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('name')}</span>
              <input
                value={form.name}
                maxLength={CAMPAIGN_NAME_MAX}
                onChange={e => setForm(f => (f ? { ...f, name: e.target.value } : f))}
                className={FIELD_CLASSES}
              />
            </label>

            {/* AI draft */}
            <div className="rounded-md border border-dashed border-border p-3">
              {!showAiBox ? (
                <Button variant="link" size="sm" type="button" onClick={() => setShowAiBox(true)}>
                  {t('aiDraftOpen')}
                </Button>
              ) : (
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t('aiDraftLabel')}</span>
                    <textarea
                      value={aiBrief}
                      onChange={e => setAiBrief(e.target.value)}
                      minLength={3}
                      maxLength={500}
                      rows={3}
                      placeholder={t('aiDraftPlaceholder')}
                      className={`${TEXTAREA_CLASSES} resize-y`}
                    />
                  </label>
                  {aiError && <p className="text-xs text-destructive-ink">{aiError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setShowAiBox(false);
                        setAiBrief('');
                        setAiError(null);
                      }}
                      disabled={aiLoading}
                    >
                      {tc('cancel')}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      type="button"
                      onClick={() => void submitAiDraft()}
                      disabled={
                        aiLoading || aiBrief.trim().length < 3 || aiBrief.trim().length > 500
                      }
                    >
                      {aiLoading ? t('aiDraftGenerating') : t('aiDraftGenerate')}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* EN panel */}
            <div className="rounded-md border border-border p-3 space-y-2">
              <h3 className="text-sm font-semibold">{t('englishPanel')}</h3>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('subject')}
                </span>
                <input
                  value={form.subject}
                  maxLength={CAMPAIGN_SUBJECT_MAX}
                  onChange={e => setForm(f => (f ? { ...f, subject: e.target.value } : f))}
                  className={FIELD_CLASSES}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('body')}
                </span>
                <textarea
                  value={form.bodyHtml}
                  maxLength={CAMPAIGN_BODY_MAX}
                  onChange={e => setForm(f => (f ? { ...f, bodyHtml: e.target.value } : f))}
                  rows={8}
                  className={`${TEXTAREA_CLASSES} font-mono resize-y`}
                />
              </label>
              {form.bodyHtml.trim() && (
                <div>
                  <Button
                    variant="link"
                    size="sm"
                    type="button"
                    onClick={() => setPreviewEn(p => !p)}
                  >
                    {previewEn ? t('previewHide') : t('previewShow')}
                  </Button>
                  {previewEn && (
                    <div className="mt-2 overflow-hidden rounded-md border border-border bg-white">
                      <iframe
                        title={t('previewTitleEn')}
                        sandbox=""
                        srcDoc={form.bodyHtml}
                        className="h-64 w-full border-0"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* AR panel */}
            <div className="rounded-md border border-border p-3 space-y-2">
              <h3 className="text-sm font-semibold">{t('arabicPanel')}</h3>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('subject')}
                </span>
                <input
                  value={form.subjectAr}
                  dir="rtl"
                  maxLength={CAMPAIGN_SUBJECT_MAX}
                  onChange={e => setForm(f => (f ? { ...f, subjectAr: e.target.value } : f))}
                  className={FIELD_CLASSES}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('body')}
                </span>
                <textarea
                  value={form.bodyHtmlAr}
                  dir="rtl"
                  maxLength={CAMPAIGN_BODY_MAX}
                  onChange={e => setForm(f => (f ? { ...f, bodyHtmlAr: e.target.value } : f))}
                  rows={8}
                  className={`${TEXTAREA_CLASSES} font-mono resize-y`}
                />
              </label>
              {form.bodyHtmlAr.trim() && (
                <div>
                  <Button
                    variant="link"
                    size="sm"
                    type="button"
                    onClick={() => setPreviewAr(p => !p)}
                  >
                    {previewAr ? t('previewHide') : t('previewShow')}
                  </Button>
                  {previewAr && (
                    <div className="mt-2 overflow-hidden rounded-md border border-border bg-white">
                      <iframe
                        title={t('previewTitleAr')}
                        sandbox=""
                        srcDoc={form.bodyHtmlAr}
                        dir="rtl"
                        className="h-64 w-full border-0"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Locale strategy */}
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('localeStrategy')}</span>
              <select
                value={form.localeStrategy}
                onChange={e =>
                  setForm(f =>
                    f ? { ...f, localeStrategy: e.target.value as CampaignLocaleStrategy } : f
                  )
                }
                className={FIELD_CLASSES}
              >
                <option value="subscriber">{t('localeStrategySubscriber')}</option>
                <option value="en">{t('localeStrategyEn')}</option>
                <option value="ar">{t('localeStrategyAr')}</option>
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('localeStrategyHint')}
              </span>
            </label>

            {/* Audience */}
            {audience && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <p className="font-medium text-foreground">
                  {t('audienceCount', { count: audience.count })}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('audienceRemaining', {
                    remaining: audience.remainingToday,
                    cap: audience.dailyCap,
                  })}
                </p>
              </div>
            )}

            {!sendable && <p className="text-xs text-muted-foreground">{t('notSendableHint')}</p>}

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button
                variant="default"
                size="md"
                type="button"
                onClick={() => void save()}
                disabled={saving || !isDirty}
              >
                {saving ? tc('saving') : tc('save')}
              </Button>
              <Button
                variant="outline"
                size="md"
                type="button"
                onClick={() => void sendTest()}
                disabled={testSending || !sendable}
              >
                {testSending ? t('sendingTest') : t('sendTest')}
              </Button>
              <Button
                variant="outline"
                size="md"
                className="ms-auto border-destructive/40 text-destructive-ink"
                type="button"
                onClick={() => setPendingAction('delete')}
              >
                {t('deleteDraft')}
              </Button>
            </div>

            {testResult && (
              <p className="text-sm text-emerald-700">
                {t('testSentTo', {
                  email: testResult.sentTo,
                  locales: testResult.locales.join(', '),
                })}
              </p>
            )}

            {/* Send now / schedule */}
            <div className="rounded-md border border-border p-3 space-y-3">
              <h3 className="text-sm font-semibold">{t('sendHeading')}</h3>
              <Button
                variant="default"
                size="md"
                type="button"
                onClick={() => setPendingAction('sendNow')}
                disabled={!sendable}
              >
                {t('sendNow')}
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="datetime-local"
                  value={scheduleInput}
                  onChange={e => setScheduleInput(e.target.value)}
                  className={FIELD_CLASSES}
                />
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={() => setPendingAction('schedule')}
                  disabled={!sendable || !scheduleInput}
                >
                  {t('scheduleButton')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Read-only summary */}
            <div className="rounded-md border border-border p-4 space-y-2 text-sm">
              <p>
                <span className="font-medium">{tD('subjectEn')}: </span>
                {campaign.subject || '—'}
              </p>
              <p dir="rtl">
                <span className="font-medium">{tD('subjectAr')}: </span>
                {campaign.subjectAr || '—'}
              </p>
              {campaign.scheduledAt && (
                <p>
                  <span className="font-medium">{tD('scheduledAt')}: </span>
                  {formatDateTime(campaign.scheduledAt)}
                </p>
              )}
              {campaign.sentAt && (
                <p>
                  <span className="font-medium">{tD('sentAt')}: </span>
                  {formatDateTime(campaign.sentAt)}
                </p>
              )}
              {campaign.lastError && (
                <p className="text-destructive-ink">
                  <span className="font-medium">{tD('lastError')}: </span>
                  {campaign.lastError}
                </p>
              )}
            </div>

            {statusCounts && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {(['queued', 'sent', 'failed', 'bounced', 'unsubscribed'] as const).map(key => (
                  <div key={key} className="rounded-md border border-border p-2 text-center">
                    <p className="text-lg font-semibold tabular-nums">{statusCounts[key]}</p>
                    <p className="text-xs text-muted-foreground">{tRecipientStatus(key)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-border pt-4">
              {(campaign.status === 'scheduled' || campaign.status === 'sending') && (
                <Button
                  variant="outline"
                  size="md"
                  className="border-destructive/40 text-destructive-ink"
                  type="button"
                  onClick={() => setPendingAction('cancel')}
                >
                  {tD('cancelCampaign')}
                </Button>
              )}
              {(campaign.status === 'cancelled' || campaign.status === 'failed') &&
                (hasSendHistory ? (
                  <p className="text-xs text-muted-foreground">{tD('sendHistoryPermanent')}</p>
                ) : (
                  <Button
                    variant="outline"
                    size="md"
                    className="border-destructive/40 text-destructive-ink"
                    type="button"
                    onClick={() => setPendingAction('delete')}
                  >
                    {tc('delete')}
                  </Button>
                ))}
            </div>

            {/* Per-recipient table */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{tD('recipientsHeading')}</h3>
                <select
                  value={statusFilter}
                  onChange={e =>
                    setStatusFilter(e.target.value as '' | CampaignRecipientStatusValue)
                  }
                  className={FIELD_CLASSES}
                >
                  <option value="">{tD('allStatuses')}</option>
                  {CAMPAIGN_RECIPIENT_STATUSES.map(s => (
                    <option key={s} value={s}>
                      {tRecipientStatus(s)}
                    </option>
                  ))}
                </select>
              </div>

              {recipientsLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{tc('loading')}</p>
              ) : recipients.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {tD('noRecipients')}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-start font-medium">{tD('colEmail')}</th>
                        <th className="px-3 py-2 text-start font-medium">{tD('colLocale')}</th>
                        <th className="px-3 py-2 text-start font-medium">{tD('colStatus')}</th>
                        <th className="px-3 py-2 text-start font-medium">{tD('colSentAt')}</th>
                        <th className="px-3 py-2 text-start font-medium">{tD('colError')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map(r => (
                        <tr key={r.id} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                          <td className="px-3 py-2 uppercase">{r.locale}</td>
                          <td className="px-3 py-2">
                            <OrderStatusBadge
                              status={r.status}
                              namespace="campaigns.recipientStatus"
                              colorMap={RECIPIENT_STATUS_COLORS}
                            />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {r.unsubscribedAt
                              ? tD('unsubscribedAtValue', {
                                  date: formatDateTime(r.unsubscribedAt),
                                })
                              : formatDateTime(r.sentAt)}
                          </td>
                          <td className="px-3 py-2 text-xs text-destructive-ink">
                            {r.error || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {recipientsCursor && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="md"
                    type="button"
                    onClick={() =>
                      void fetchRecipients({
                        reset: false,
                        cursor: recipientsCursor,
                        status: statusFilter,
                      })
                    }
                    disabled={recipientsLoadingMore}
                  >
                    {recipientsLoadingMore ? tc('loading') : tD('loadMore')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingAction === 'delete' && (
        <ConfirmDialog
          title={t('confirmDeleteTitle')}
          description={t('confirmDeleteDescription')}
          confirmLabel={deleting ? tc('deleting') : tc('delete')}
          cancelLabel={tc('cancel')}
          saving={deleting}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {pendingAction === 'cancel' && (
        <ConfirmDialog
          title={tD('confirmCancelTitle')}
          description={tD('confirmCancelDescription')}
          confirmLabel={cancelling ? tc('saving') : tD('confirmCancelButton')}
          cancelLabel={tc('cancel')}
          saving={cancelling}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void confirmCancel()}
        />
      )}

      {(pendingAction === 'sendNow' || pendingAction === 'schedule') && (
        <ConfirmDialog
          title={t('confirmSendTitle')}
          description={
            pendingAction === 'sendNow'
              ? t('confirmSendNowDescription', { count: audience?.count ?? 0 })
              : t('confirmScheduleDescription', {
                  count: audience?.count ?? 0,
                  date: scheduleInput ? formatDateTime(new Date(scheduleInput).toISOString()) : '',
                })
          }
          confirmLabel={sendSubmitting ? t('sending') : t('confirmSendButton')}
          cancelLabel={tc('cancel')}
          saving={sendSubmitting}
          danger={false}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void confirmSend()}
        />
      )}
    </AdminLayout>
  );
}
