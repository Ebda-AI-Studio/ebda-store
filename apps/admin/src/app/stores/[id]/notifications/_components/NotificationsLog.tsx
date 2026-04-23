'use client';

import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { NotificationStatusBadge } from './NotificationStatusBadge';
import type { NotificationLog } from './types';

interface NotificationsLogProps {
  logs: NotificationLog[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  channelFilter: string;
  statusFilter: string;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  onChannelFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onPageChange: (updater: (prev: number) => number) => void;
}

const CHANNEL_LABEL_KEYS: Record<string, string> = {
  whatsapp: 'channelNames.whatsapp',
  sms: 'channelNames.sms',
  push_notifications: 'channelNames.push',
};

/**
 * Recent notifications log — filter bar + table + pagination. Handles its
 * own empty state when no rows match the current filters.
 */
export function NotificationsLog({
  logs,
  total,
  page,
  limit,
  pages,
  channelFilter,
  statusFilter,
  whatsappEnabled,
  smsEnabled,
  pushEnabled,
  onChannelFilterChange,
  onStatusFilterChange,
  onPageChange,
}: NotificationsLogProps) {
  const t = useT('notifications.log');
  const tShared = useT('notifications.shared');

  const channelLabel = (channel: string): string => {
    const key = CHANNEL_LABEL_KEYS[channel];
    return key ? tShared(key) : channel;
  };

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle', { limit })}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={channelFilter}
            onChange={e => onChannelFilterChange(e.target.value)}
            aria-label={t('filters.channelLabel')}
            className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          >
            <option value="all">{t('filters.allChannels')}</option>
            {whatsappEnabled && (
              <option value="whatsapp">{tShared('channelNames.whatsapp')}</option>
            )}
            {smsEnabled && <option value="sms">{tShared('channelNames.sms')}</option>}
            {pushEnabled && (
              <option value="push_notifications">{tShared('channelNames.pushShort')}</option>
            )}
          </select>
          <select
            value={statusFilter}
            onChange={e => onStatusFilterChange(e.target.value)}
            aria-label={t('filters.statusLabel')}
            className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          >
            <option value="all">{t('filters.allStatuses')}</option>
            <option value="sent">{t('status.sent')}</option>
            <option value="delivered">{t('status.delivered')}</option>
            <option value="failed">{t('status.failed')}</option>
            <option value="pending">{t('status.pending')}</option>
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
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" aria-label={t('tableLabel')}>
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.timestamp')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.event')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.channel')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.recipient')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.status')}
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
                    <td className="px-6 py-3 text-sm text-foreground">
                      {channelLabel(log.channel)}
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground">
                      {log.recipient || '—'}
                    </td>
                    <td className="px-6 py-3">
                      <NotificationStatusBadge status={log.status} />
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

          {pages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                {t('pagination.summary', { page, pages, total })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPageChange(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  {t('pagination.previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPageChange(p => Math.min(pages, p + 1))}
                  disabled={page === pages}
                >
                  {t('pagination.next')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
