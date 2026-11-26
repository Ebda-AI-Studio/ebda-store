'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { NotificationsEmptyState } from './_components/NotificationsEmptyState';
import { SmsChannelCard } from './_components/SmsChannelCard';
import { PushChannelCard } from './_components/PushChannelCard';
import { EnableOrderAlertsButton } from '../../../../components/EnableOrderAlertsButton';
import { BroadcastComposerCard } from './_components/BroadcastComposerCard';
import { EventConfigTable } from './_components/EventConfigTable';
import { NotificationsLog } from './_components/NotificationsLog';
import { WebPushToggleCard } from './_components/WebPushToggleCard';
import Link from 'next/link';
import {
  DEFAULT_CONFIGS,
  DEFAULT_EVENTS,
  mergeStoredEvents,
  type ChannelConfig,
  type ChannelKey,
  type EventConfig,
  type LogsData,
  type NotificationConfigs,
  type NotificationLog,
  type TestStatus,
} from './_components/types';

const CHANNEL_NAME_KEYS: Record<ChannelKey, string> = {
  sms: 'channelNames.sms',
  push_notifications: 'channelNames.push',
};

export default function NotificationsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params.id as string;
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const { user } = useAuth();
  const { success: toastSuccess, error: showError } = useToast();
  const tPage = useT('notifications.page');
  const tShared = useT('notifications.shared');
  const tToast = useT('notifications.toast');

  // Data state
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<NotificationConfigs>(DEFAULT_CONFIGS);
  const [events, setEvents] = useState<EventConfig[]>(DEFAULT_EVENTS);
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const logsLimit = 10;
  const [logsChannelFilter, setLogsChannelFilter] = useState('all');
  const [logsStatusFilter, setLogsStatusFilter] = useState('all');

  // Saving states
  const [savingChannel, setSavingChannel] = useState<string | null>(null);
  const [savingEvents, setSavingEvents] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Record<ChannelKey, TestStatus>>({
    sms: 'idle',
    push_notifications: 'idle',
  });

  // Feature flags
  const smsEnabled = isEnabled('sms');
  const pushEnabled = isEnabled('push_notifications');
  const anyChannelEnabled = smsEnabled || pushEnabled;

  // Hide the page from store_admins when the super_admin hasn't enabled
  // any notification channels for their store. Super_admins still get
  // through (they're the ones who flip the toggles). Wait until features
  // have loaded to avoid a redirect race on first paint.
  useEffect(() => {
    if (featuresLoading) return;
    if (anyChannelEnabled) return;
    if (user?.role === 'super_admin') return;
    router.replace(`/stores/${storeId}`);
  }, [featuresLoading, anyChannelEnabled, user?.role, router, storeId]);

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    const { data } = await apiGet<{ configs: NotificationConfigs }>(
      `/api/v1/stores/${storeId}/notifications/configs`
    );
    if (data?.configs) {
      setConfigs({ ...DEFAULT_CONFIGS, ...data.configs });
    }
  }, [storeId]);

  const fetchEvents = useCallback(async () => {
    const { data } = await apiGet<{ events: unknown }>(
      `/api/v1/stores/${storeId}/notifications/events`
    );
    if (data?.events) setEvents(mergeStoredEvents(data.events));
  }, [storeId]);

  const fetchLogs = useCallback(async () => {
    const qs = new URLSearchParams({
      limit: String(logsLimit),
      page: String(logsPage),
    });
    if (logsChannelFilter !== 'all') qs.set('channel', logsChannelFilter);
    if (logsStatusFilter !== 'all') qs.set('status', logsStatusFilter);

    const { data } = await apiGet<LogsData>(`/api/v1/stores/${storeId}/notifications/logs?${qs}`);
    if (data) {
      setLogs(data.logs || []);
      setLogsTotal(data.total || 0);
    }
  }, [storeId, logsPage, logsLimit, logsChannelFilter, logsStatusFilter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchConfigs(), fetchEvents(), fetchLogs()]);
    setLoading(false);
  }, [fetchConfigs, fetchEvents, fetchLogs]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsPage, logsChannelFilter, logsStatusFilter]);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const channelLabel = useCallback(
    (channel: ChannelKey): string => tShared(CHANNEL_NAME_KEYS[channel]),
    [tShared]
  );

  // ─── Save Channel Config ────────────────────────────────────────────────────

  const handleSaveChannel = async (channel: ChannelKey) => {
    setSavingChannel(channel);
    try {
      // The API expects `{ provider, credentials, enabled }`. The admin
      // form holds credentials as flat fields per channel; flatten them
      // back into a credentials object here so the PUT body matches the
      // server-side Zod schema. Without this, every save returned 400
      // because the form's flat `{ enabled, phoneNumberId, ... }` shape
      // was missing the required `provider` and `credentials` keys.
      const cfg = configs[channel];
      const { enabled } = cfg;
      const credentials: Record<string, unknown> = {};
      if (channel === 'sms') {
        if (cfg.appSid) credentials.appSid = cfg.appSid;
        if (cfg.senderId) credentials.senderId = cfg.senderId;
      }
      // push_notifications has no per-store credentials (VAPID is
      // platform-wide) — credentials stays empty.

      const { error } = await apiPut(`/api/v1/stores/${storeId}/notifications/configs/${channel}`, {
        provider: channel,
        credentials,
        enabled,
      });
      if (!error) {
        toastSuccess(
          tToast('savedTitle'),
          tToast('channelSavedDescription', { channel: channelLabel(channel) })
        );
      } else {
        showError(tToast('errorTitle'), error.message || tToast('saveFailed'));
      }
    } catch (err) {
      console.error('Failed to save channel config:', err);
      showError(tToast('errorTitle'), tToast('saveFailedRetry'));
    } finally {
      setSavingChannel(null);
    }
  };

  // ─── Test Connection ────────────────────────────────────────────────────────

  const handleTestConnection = async (channel: ChannelKey) => {
    setTestingChannel(channel);
    setTestStatus(prev => ({ ...prev, [channel]: 'testing' }));
    try {
      const { data, error } = await apiPost<{ success?: boolean; message?: string }>(
        `/api/v1/stores/${storeId}/notifications/test/${channel}`
      );
      // The route answers HTTP 200 with { success:false, message } when the channel was tested (or is not
      // testable) and failed: that is a failure, not a green tick (Ruling TESTCONN-1).
      if (!error && data?.success === false) {
        setTestStatus(prev => ({ ...prev, [channel]: 'error' }));
        showError(tToast('connectionFailedTitle'), data.message || tToast('testFailed'));
      } else if (!error) {
        setTestStatus(prev => ({ ...prev, [channel]: 'success' }));
        toastSuccess(
          tToast('connectionOkTitle'),
          tToast('connectionOkDescription', { channel: channelLabel(channel) })
        );
      } else {
        setTestStatus(prev => ({ ...prev, [channel]: 'error' }));
        showError(tToast('connectionFailedTitle'), error.message || tToast('testFailed'));
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setTestStatus(prev => ({ ...prev, [channel]: 'error' }));
      showError(tToast('errorTitle'), tToast('testFailed'));
    } finally {
      setTestingChannel(null);
    }
  };

  // ─── Save Events ────────────────────────────────────────────────────────────

  const handleSaveEvents = async () => {
    setSavingEvents(true);
    try {
      // The events table stores the push toggle under `push_notifications`
      // (matches the channel key the rest of the admin uses) but the API
      // schema canonicalises it to `push`. Map here on save so a fresh
      // save round-trips cleanly.
      const payload = events.map(e => ({
        event: e.event,
        sms: e.sms,
        push: e.push_notifications,
      }));
      const { error } = await apiPut(`/api/v1/stores/${storeId}/notifications/events`, {
        events: payload,
      });
      if (!error) {
        toastSuccess(tToast('savedTitle'), tToast('eventsSavedDescription'));
      } else {
        showError(tToast('errorTitle'), error.message || tToast('eventsSaveFailed'));
      }
    } catch (err) {
      console.error('Failed to save events:', err);
      showError(tToast('errorTitle'), tToast('eventsSaveFailed'));
    } finally {
      setSavingEvents(false);
    }
  };

  // ─── Config Patchers ────────────────────────────────────────────────────────

  function updateConfig(channel: ChannelKey, patch: Partial<ChannelConfig>) {
    setConfigs(prev => ({
      ...prev,
      [channel]: { ...prev[channel], ...patch },
    }));
  }

  function toggleEventChannel(eventIndex: number, channel: 'sms' | 'push_notifications') {
    setEvents(prev =>
      prev.map((ev, i) => (i === eventIndex ? { ...ev, [channel]: !ev[channel] } : ev))
    );
  }

  const logsPages = Math.max(1, Math.ceil(logsTotal / logsLimit));
  // Open the credentials group only while a channel the plan includes still has nothing configured.
  const needsChannelSetup =
    (smsEnabled && !configs.sms.enabled) || (pushEnabled && !configs.push_notifications.enabled);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <div className="mb-6">
        <EnableOrderAlertsButton />
      </div>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !anyChannelEnabled ? (
        <NotificationsEmptyState />
      ) : (
        <div className="space-y-6">
          {/* 1. What the customer is told, and on which channel: the question merchants come here with */}
          <EventConfigTable
            events={events}
            smsEnabled={smsEnabled}
            pushEnabled={pushEnabled}
            saving={savingEvents}
            onToggleEventChannel={toggleEventChannel}
            onSave={handleSaveEvents}
          />

          {pushEnabled && <WebPushToggleCard storeId={storeId} />}

          {/* 2. Channel credentials: set once, then out of the way */}
          <details className="rounded-md border border-border bg-card p-4" open={needsChannelSetup}>
            <summary className="cursor-pointer text-sm font-semibold text-foreground">
              {tPage('channelsTitle')}
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">{tPage('channelsHint')}</p>
            <div className="mt-4 space-y-6">
              {smsEnabled && (
                <SmsChannelCard
                  config={configs.sms}
                  saving={savingChannel === 'sms'}
                  testing={testingChannel === 'sms'}
                  testStatus={testStatus.sms}
                  onConfigChange={patch => updateConfig('sms', patch)}
                  onSave={() => handleSaveChannel('sms')}
                  onTest={() => handleTestConnection('sms')}
                />
              )}

              {pushEnabled && (
                <PushChannelCard
                  storeId={storeId}
                  config={configs.push_notifications}
                  saving={savingChannel === 'push_notifications'}
                  testing={testingChannel === 'push_notifications'}
                  testStatus={testStatus.push_notifications}
                  onConfigChange={patch => updateConfig('push_notifications', patch)}
                  onSave={() => handleSaveChannel('push_notifications')}
                  onTest={() => handleTestConnection('push_notifications')}
                />
              )}
            </div>
          </details>

          {/* 3. A one-off message to every subscriber is a campaign, not a setting */}
          {pushEnabled && (
            <details className="rounded-md border border-border bg-card p-4">
              <summary className="cursor-pointer text-sm font-semibold text-foreground">
                {tPage('broadcastTitle')}
              </summary>
              <p className="mt-1 text-xs text-muted-foreground">
                {tPage('broadcastHint')}{' '}
                <Link
                  href={`/stores/${storeId}/campaigns`}
                  className="font-medium text-primary-ink underline underline-offset-2"
                >
                  {tPage('campaignsLink')}
                </Link>
              </p>
              <div className="mt-4">
                <BroadcastComposerCard storeId={storeId} />
              </div>
            </details>
          )}

          <NotificationsLog
            logs={logs}
            total={logsTotal}
            page={logsPage}
            limit={logsLimit}
            pages={logsPages}
            channelFilter={logsChannelFilter}
            statusFilter={logsStatusFilter}
            smsEnabled={smsEnabled}
            pushEnabled={pushEnabled}
            onChannelFilterChange={value => {
              setLogsChannelFilter(value);
              setLogsPage(1);
            }}
            onStatusFilterChange={value => {
              setLogsStatusFilter(value);
              setLogsPage(1);
            }}
            onPageChange={updater => setLogsPage(prev => updater(prev))}
          />
        </div>
      )}
    </AdminLayout>
  );
}
