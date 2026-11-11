'use client';

/**
 * Storefront broadcast composer.
 *
 * Lets a store admin send a OneSignal push to every storefront subscriber
 * whose device is tagged with this storeId. The actual filter is enforced
 * server-side in `OneSignalService.broadcastToStore`; the UI here only
 * collects the title/body/url payload.
 *
 * Three render paths:
 *  1. Loading/idle: render the composer form.
 *  2. 503 PUSH_NOT_CONFIGURED on send: surface a yellow config note. The
 *     same note is rendered preemptively if a parent passes
 *     `notConfigured` based on the channel config probe.
 *  3. Submit success: toast + reset form.
 */

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../lib/api';
import { withNumerals } from '@ebda/shared';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

interface BroadcastFormState {
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  url: string;
}

const EMPTY: BroadcastFormState = {
  titleEn: '',
  titleAr: '',
  bodyEn: '',
  bodyAr: '',
  url: '',
};

interface BroadcastSummary {
  id: string;
  headings?: { en?: string; ar?: string };
  contents?: { en?: string; ar?: string };
  url?: string;
  successful?: number;
  converted?: number;
  failed?: number;
  remaining?: number;
  queued_at?: number;
  completed_at?: number;
}

export function BroadcastComposerCard({ storeId }: { storeId: string }) {
  const t = useT('notifications.broadcast');
  const tShared = useT('notifications.shared');
  const tToast = useT('notifications.toast');
  const { success: toastSuccess, error: showError } = useToast();

  const [form, setForm] = useState<BroadcastFormState>(EMPTY);
  const [sending, setSending] = useState(false);
  // null = unknown, true = env vars missing on server, false = ready
  const [notConfigured, setNotConfigured] = useState<boolean | null>(null);
  const [recent, setRecent] = useState<BroadcastSummary[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  const fetchRecent = useCallback(async () => {
    setRecentLoading(true);
    try {
      const { data, error } = await apiGet<{ broadcasts: BroadcastSummary[] }>(
        `/api/v1/admin/stores/${storeId}/push/broadcasts`
      );
      if (error?.code === 'PUSH_NOT_CONFIGURED') {
        setNotConfigured(true);
        setRecent([]);
        return;
      }
      if (data?.broadcasts) {
        setRecent(data.broadcasts);
        setNotConfigured(false);
      }
    } catch {
      // Non-fatal — the composer is still usable without history
    } finally {
      setRecentLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  const update = <K extends keyof BroadcastFormState>(key: K, value: BroadcastFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const formValid =
    form.titleEn.trim().length > 0 &&
    form.titleAr.trim().length > 0 &&
    form.bodyEn.trim().length > 0 &&
    form.bodyAr.trim().length > 0;

  const handleSend = async () => {
    if (!formValid || sending) return;
    setSending(true);
    try {
      const payload: Record<string, string> = {
        titleEn: form.titleEn.trim(),
        titleAr: form.titleAr.trim(),
        bodyEn: form.bodyEn.trim(),
        bodyAr: form.bodyAr.trim(),
      };
      const trimmedUrl = form.url.trim();
      if (trimmedUrl) payload.url = trimmedUrl;

      const { data, error } = await apiPost<{ id: string; recipients: number }>(
        `/api/v1/admin/stores/${storeId}/push/broadcast`,
        payload
      );

      if (error) {
        if (error.code === 'PUSH_NOT_CONFIGURED') {
          setNotConfigured(true);
          showError(t('notConfiguredTitle'), t('notConfiguredDescription'));
          return;
        }
        showError(tToast('errorTitle'), error.message || t('sendFailed'));
        return;
      }

      toastSuccess(t('sentTitle'), t('sentDescription', { count: data?.recipients ?? 0 }));
      setForm(EMPTY);
      // Refresh the recent list so the merchant immediately sees what they sent
      fetchRecent();
    } catch (err) {
      console.error('Broadcast send failed:', err);
      showError(tToast('errorTitle'), t('sendFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
            <svg
              className="w-5 h-5 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"
              />
            </svg>
          </div>
          <div>
            <h2
              data-setting-id="notifications.broadcast"
              className="text-lg font-semibold text-foreground"
            >
              {t('title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
      </div>

      {notConfigured && (
        <div
          role="alert"
          className="mb-4 p-4 rounded-lg border border-warning/40 bg-warning/10 text-sm text-foreground"
        >
          <p className="font-medium mb-1">{t('notConfiguredTitle')}</p>
          <p className="text-muted-foreground">{t('notConfiguredDescription')}</p>
          <p className="text-muted-foreground mt-2">
            {/* i18n-gate-allow: environment variable name */}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">ONESIGNAL_APP_ID</code>{' '}
            {t('and')} {/* i18n-gate-allow: environment variable name */}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">ONESIGNAL_REST_API_KEY</code>
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.titleEn')}
          </label>
          <input
            type="text"
            value={form.titleEn}
            onChange={e => update('titleEn', e.target.value)}
            placeholder={t('placeholders.titleEn')}
            maxLength={200}
            disabled={sending}
            className={FIELD_CLASSES}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.titleAr')}
          </label>
          <input
            type="text"
            value={form.titleAr}
            onChange={e => update('titleAr', e.target.value)}
            placeholder={t('placeholders.titleAr')}
            maxLength={200}
            disabled={sending}
            dir="rtl"
            className={FIELD_CLASSES}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.bodyEn')}
          </label>
          <textarea
            value={form.bodyEn}
            onChange={e => update('bodyEn', e.target.value)}
            placeholder={t('placeholders.bodyEn')}
            maxLength={2000}
            rows={3}
            disabled={sending}
            className={TEXTAREA_CLASSES}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.bodyAr')}
          </label>
          <textarea
            value={form.bodyAr}
            onChange={e => update('bodyAr', e.target.value)}
            placeholder={t('placeholders.bodyAr')}
            maxLength={2000}
            rows={3}
            disabled={sending}
            dir="rtl"
            className={TEXTAREA_CLASSES}
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.url')}
          </label>
          <input
            type="url"
            value={form.url}
            onChange={e => update('url', e.target.value)}
            placeholder={t('placeholders.url')}
            maxLength={2000}
            disabled={sending}
            className={FIELD_CLASSES}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('urlHelp')}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSend}
          disabled={!formValid || sending || notConfigured === true}
          size="sm"
        >
          {sending && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
          )}
          {sending ? t('sending') : t('send')}
        </Button>
        <span className="text-xs text-muted-foreground">{tShared('channelNames.push')}</span>
      </div>

      {/* Recent broadcasts */}
      <div className="mt-8 border-t border-border pt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('recentTitle')}</h3>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            type="button"
            onClick={fetchRecent}
            disabled={recentLoading}
          >
            {recentLoading ? t('refreshing') : t('refresh')}
          </Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('recentEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {recent.map(b => {
              const heading = b.headings?.en || b.headings?.ar || t('untitled');
              const sent = (b.successful ?? 0) + (b.failed ?? 0);
              const ts = b.completed_at || b.queued_at;
              const when = ts ? new Date(ts * 1000).toLocaleString(undefined, withNumerals()) : '';
              return (
                <li
                  key={b.id}
                  className="p-3 rounded-lg border border-border bg-background flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{heading}</p>
                    {when && <p className="text-xs text-muted-foreground mt-0.5">{when}</p>}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap text-end">
                    <div>
                      {t('deliveredCount', { count: b.successful ?? 0 })} / {sent}
                    </div>
                    <div>{t('clickedCount', { count: b.converted ?? 0 })}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
