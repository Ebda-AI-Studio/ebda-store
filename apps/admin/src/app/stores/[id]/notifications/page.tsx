'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChannelConfig {
  enabled: boolean;
  // WhatsApp
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  // SMS
  appSid?: string;
  senderId?: string;
  // Push (web-push / VAPID is platform-wide — no per-store credentials)
  subscriberCount?: number;
}

interface NotificationConfigs {
  whatsapp: ChannelConfig;
  sms: ChannelConfig;
  push_notifications: ChannelConfig;
}

interface EventConfig {
  event: string;
  label: string;
  whatsapp: boolean;
  sms: boolean;
  push_notifications: boolean;
}

interface NotificationLog {
  id: string;
  createdAt: string;
  event: string;
  channel: string;
  status: string;
  recipient?: string;
  error?: string;
}

interface LogsData {
  logs: NotificationLog[];
  total: number;
  page: number;
  limit: number;
}

const DEFAULT_CONFIGS: NotificationConfigs = {
  whatsapp: { enabled: false },
  sms: { enabled: false },
  push_notifications: { enabled: false },
};

const DEFAULT_EVENTS: EventConfig[] = [
  {
    event: 'order_confirmed',
    label: 'Order Confirmed',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_success',
    label: 'Payment Success',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_failed',
    label: 'Payment Failed',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_shipped',
    label: 'Order Shipped',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_delivered',
    label: 'Order Delivered',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_cancelled',
    label: 'Order Cancelled',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_refunded',
    label: 'Order Refunded',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
];

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    sent: 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]',
    delivered: 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]',
    failed: 'bg-destructive/10 text-destructive',
    pending: 'bg-muted text-muted-foreground',
    queued: 'bg-primary/10 text-primary',
  };
  const cls = colors[status] || 'bg-muted text-foreground';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ─── Connection Status ────────────────────────────────────────────────────────

function ConnectionStatus({ status }: { status: 'idle' | 'testing' | 'success' | 'error' }) {
  if (status === 'idle') return null;
  if (status === 'testing')
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className="animate-spin inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
        Testing…
      </span>
    );
  if (status === 'success')
    return (
      <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--success))]">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Connected
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-sm text-destructive">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
      Failed
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { isEnabled } = useFeatures();
  const { success: toastSuccess, error: showError } = useToast();

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
  const [testStatus, setTestStatus] = useState<
    Record<string, 'idle' | 'testing' | 'success' | 'error'>
  >({
    whatsapp: 'idle',
    sms: 'idle',
    push_notifications: 'idle',
  });

  // Feature flags
  const whatsappEnabled = isEnabled('whatsapp');
  const smsEnabled = isEnabled('sms');
  const pushEnabled = isEnabled('push_notifications');
  const anyChannelEnabled = whatsappEnabled || smsEnabled || pushEnabled;

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
    const { data } = await apiGet<{ events: EventConfig[] }>(
      `/api/v1/stores/${storeId}/notifications/events`
    );
    if (data?.events && data.events.length > 0) {
      setEvents(data.events);
    }
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

  // ─── Save Channel Config ────────────────────────────────────────────────────

  const handleSaveChannel = async (channel: keyof NotificationConfigs) => {
    setSavingChannel(channel);
    try {
      const { error } = await apiPut(
        `/api/v1/stores/${storeId}/notifications/configs/${channel}`,
        configs[channel]
      );
      if (!error) {
        toastSuccess('Saved', `${channelLabel(channel)} settings saved.`);
      } else {
        showError('Error', error.message || 'Failed to save settings.');
      }
    } catch (err) {
      console.error('Failed to save channel config:', err);
      showError('Error', 'Failed to save settings. Please try again.');
    } finally {
      setSavingChannel(null);
    }
  };

  // ─── Test Connection ────────────────────────────────────────────────────────

  const handleTestConnection = async (channel: keyof NotificationConfigs) => {
    setTestingChannel(channel);
    setTestStatus(prev => ({ ...prev, [channel]: 'testing' }));
    try {
      const { error } = await apiPost(`/api/v1/stores/${storeId}/notifications/test/${channel}`);
      if (!error) {
        setTestStatus(prev => ({ ...prev, [channel]: 'success' }));
        toastSuccess('Connection OK', `${channelLabel(channel)} connection test passed.`);
      } else {
        setTestStatus(prev => ({ ...prev, [channel]: 'error' }));
        showError('Connection Failed', error.message || 'Test failed.');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setTestStatus(prev => ({ ...prev, [channel]: 'error' }));
      showError('Error', 'Test connection failed.');
    } finally {
      setTestingChannel(null);
    }
  };

  // ─── Save Events ────────────────────────────────────────────────────────────

  const handleSaveEvents = async () => {
    setSavingEvents(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/notifications/events`, { events });
      if (!error) {
        toastSuccess('Saved', 'Event configuration saved.');
      } else {
        showError('Error', error.message || 'Failed to save event configuration.');
      }
    } catch (err) {
      console.error('Failed to save events:', err);
      showError('Error', 'Failed to save event configuration.');
    } finally {
      setSavingEvents(false);
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function channelLabel(channel: string): string {
    const labels: Record<string, string> = {
      whatsapp: 'WhatsApp',
      sms: 'SMS',
      push_notifications: 'Push Notifications',
    };
    return labels[channel] || channel;
  }

  function updateConfig(channel: keyof NotificationConfigs, patch: Partial<ChannelConfig>) {
    setConfigs(prev => ({
      ...prev,
      [channel]: { ...prev[channel], ...patch },
    }));
  }

  function toggleEventChannel(
    eventIndex: number,
    channel: 'whatsapp' | 'sms' | 'push_notifications'
  ) {
    setEvents(prev =>
      prev.map((ev, i) => (i === eventIndex ? { ...ev, [channel]: !ev[channel] } : ev))
    );
  }

  const logsPages = Math.max(1, Math.ceil(logsTotal / logsLimit));

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title="Notifications"
      subtitle="Configure WhatsApp, SMS, and push notification channels"
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !anyChannelEnabled ? (
        // ── Empty state ──────────────────────────────────────────────────────
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            No notification channels enabled
          </h2>
          <p className="text-muted-foreground max-w-md">
            Enable notification channels (WhatsApp, SMS, or Push Notifications) in your store
            features to configure them here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── WhatsApp Setup ──────────────────────────────────────────────── */}
          {whatsappEnabled && (
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">WhatsApp</h2>
                    <p className="text-sm text-muted-foreground">WhatsApp Business API via Meta</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {configs.whatsapp.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Toggle
                    checked={configs.whatsapp.enabled}
                    onChange={val => updateConfig('whatsapp', { enabled: val })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    Phone Number ID
                  </label>
                  <input
                    type="text"
                    value={configs.whatsapp.phoneNumberId || ''}
                    onChange={e => updateConfig('whatsapp', { phoneNumberId: e.target.value })}
                    placeholder="e.g. 123456789012345"
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    WABA ID
                  </label>
                  <input
                    type="text"
                    value={configs.whatsapp.wabaId || ''}
                    onChange={e => updateConfig('whatsapp', { wabaId: e.target.value })}
                    placeholder="WhatsApp Business Account ID"
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    Access Token
                  </label>
                  <input
                    type="password"
                    value={configs.whatsapp.accessToken || ''}
                    onChange={e => updateConfig('whatsapp', { accessToken: e.target.value })}
                    placeholder="Meta permanent access token"
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={() => handleSaveChannel('whatsapp')}
                  disabled={savingChannel === 'whatsapp'}
                  size="sm"
                >
                  {savingChannel === 'whatsapp' && (
                    <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestConnection('whatsapp')}
                  disabled={testingChannel === 'whatsapp'}
                >
                  Test Connection
                </Button>
                <ConnectionStatus status={testStatus.whatsapp} />
              </div>
            </div>
          )}

          {/* ── SMS Setup ───────────────────────────────────────────────────── */}
          {smsEnabled && (
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                      />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">SMS</h2>
                    <p className="text-sm text-muted-foreground">SMS via Unifonic</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {configs.sms.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Toggle
                    checked={configs.sms.enabled}
                    onChange={val => updateConfig('sms', { enabled: val })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    App SID
                  </label>
                  <input
                    type="text"
                    value={configs.sms.appSid || ''}
                    onChange={e => updateConfig('sms', { appSid: e.target.value })}
                    placeholder="Unifonic App SID"
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    Sender ID
                  </label>
                  <input
                    type="text"
                    value={configs.sms.senderId || ''}
                    onChange={e => updateConfig('sms', { senderId: e.target.value })}
                    placeholder="e.g. MyStore"
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={() => handleSaveChannel('sms')}
                  disabled={savingChannel === 'sms'}
                  size="sm"
                >
                  {savingChannel === 'sms' && (
                    <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestConnection('sms')}
                  disabled={testingChannel === 'sms'}
                >
                  Test Connection
                </Button>
                <ConnectionStatus status={testStatus.sms} />
              </div>
            </div>
          )}

          {/* ── Push Notifications ───────────────────────────────────────────── */}
          {pushEnabled && (
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-purple-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                      />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Push Notifications</h2>
                    <p className="text-sm text-muted-foreground">
                      Standards-based Web Push (W3C Push API)
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {typeof configs.push_notifications.subscriberCount === 'number' && (
                    <span className="text-sm text-muted-foreground">
                      {configs.push_notifications.subscriberCount.toLocaleString()} subscribers
                    </span>
                  )}
                  <span className="text-sm text-muted-foreground">
                    {configs.push_notifications.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Toggle
                    checked={configs.push_notifications.enabled}
                    onChange={val => updateConfig('push_notifications', { enabled: val })}
                  />
                </div>
              </div>

              <div className="mb-4 p-4 bg-muted/50 border border-border rounded-lg">
                <p className="text-sm text-muted-foreground">
                  Push notifications use the platform VAPID configuration. No per-store setup needed
                  — just toggle Enabled.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={() => handleSaveChannel('push_notifications')}
                  disabled={savingChannel === 'push_notifications'}
                  size="sm"
                >
                  {savingChannel === 'push_notifications' && (
                    <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestConnection('push_notifications')}
                  disabled={testingChannel === 'push_notifications'}
                >
                  Test Connection
                </Button>
                <ConnectionStatus status={testStatus.push_notifications} />
              </div>
            </div>
          )}

          {/* ── Event Configuration ──────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Event Configuration</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Choose which events trigger notifications on each channel
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b border-border">
                    <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Event
                    </th>
                    {whatsappEnabled && (
                      <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">
                        WhatsApp
                      </th>
                    )}
                    {smsEnabled && (
                      <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">
                        SMS
                      </th>
                    )}
                    {pushEnabled && (
                      <th className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">
                        Push
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {events.map((ev, idx) => (
                    <tr key={ev.event} className="hover:bg-muted">
                      <td className="px-6 py-3 text-sm font-medium text-foreground">{ev.label}</td>
                      {whatsappEnabled && (
                        <td className="px-6 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={ev.whatsapp}
                            onChange={() => toggleEventChannel(idx, 'whatsapp')}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                        </td>
                      )}
                      {smsEnabled && (
                        <td className="px-6 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={ev.sms}
                            onChange={() => toggleEventChannel(idx, 'sms')}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                        </td>
                      )}
                      {pushEnabled && (
                        <td className="px-6 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={ev.push_notifications}
                            onChange={() => toggleEventChannel(idx, 'push_notifications')}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-end">
              <Button onClick={handleSaveEvents} disabled={savingEvents} size="sm">
                {savingEvents && (
                  <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                )}
                Save Event Config
              </Button>
            </div>
          </div>

          {/* ── Recent Notifications ─────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Recent Notifications</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Delivery history for the last {logsLimit} notifications
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={logsChannelFilter}
                  onChange={e => {
                    setLogsChannelFilter(e.target.value);
                    setLogsPage(1);
                  }}
                  aria-label="Filter by channel"
                  className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                >
                  <option value="all">All channels</option>
                  {whatsappEnabled && <option value="whatsapp">WhatsApp</option>}
                  {smsEnabled && <option value="sms">SMS</option>}
                  {pushEnabled && <option value="push_notifications">Push</option>}
                </select>
                <select
                  value={logsStatusFilter}
                  onChange={e => {
                    setLogsStatusFilter(e.target.value);
                    setLogsPage(1);
                  }}
                  aria-label="Filter by status"
                  className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                >
                  <option value="all">All statuses</option>
                  <option value="sent">Sent</option>
                  <option value="delivered">Delivered</option>
                  <option value="failed">Failed</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
            </div>

            {logs.length === 0 ? (
              <div className="p-12 text-center">
                <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg
                    className="w-6 h-6 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                  </svg>
                </div>
                <p className="text-muted-foreground text-sm">No notifications sent yet</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Timestamp
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Event
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Channel
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Recipient
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {logs.map(log => (
                        <tr key={log.id} className="hover:bg-muted">
                          <td className="px-6 py-3 text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          <td className="px-6 py-3 text-sm text-foreground capitalize">
                            {log.event.replace(/_/g, ' ')}
                          </td>
                          <td className="px-6 py-3 text-sm text-foreground capitalize">
                            {channelLabel(log.channel)}
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground">
                            {log.recipient || '—'}
                          </td>
                          <td className="px-6 py-3">
                            <StatusBadge status={log.status} />
                            {log.error && (
                              <p
                                className="text-xs text-destructive mt-1 truncate max-w-[200px]"
                                title={log.error}
                              >
                                {log.error}
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {logsPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-4 border-t border-border">
                    <p className="text-sm text-muted-foreground">
                      Page {logsPage} of {logsPages} ({logsTotal} total)
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setLogsPage(p => Math.max(1, p - 1))}
                        disabled={logsPage === 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setLogsPage(p => Math.min(logsPages, p + 1))}
                        disabled={logsPage === logsPages}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
