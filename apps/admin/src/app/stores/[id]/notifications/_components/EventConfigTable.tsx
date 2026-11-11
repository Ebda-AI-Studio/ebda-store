'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { EventConfig } from './types';

// Event keys that have a translation entry in notifications.events.labels.
// Any event key outside this set falls back to the server-provided label.
const KNOWN_EVENT_KEYS = new Set([
  'order_confirmed',
  'payment_success',
  'payment_failed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
]);

function translateEventLabel(eventKey: string, fallback: string, t: (k: string) => string): string {
  if (KNOWN_EVENT_KEYS.has(eventKey)) {
    return t(`labels.${eventKey}`);
  }
  return fallback;
}

interface EventConfigTableProps {
  events: EventConfig[];
  smsEnabled: boolean;
  pushEnabled: boolean;
  saving: boolean;
  onToggleEventChannel: (eventIndex: number, channel: 'sms' | 'push_notifications') => void;
  onSave: () => void;
}

/**
 * Matrix of events x channels. A checkbox for each enabled channel controls
 * whether that event fires a notification on that channel. Event labels are
 * translated via notifications.events.<eventKey> when available, falling
 * back to the server-provided label.
 */
export function EventConfigTable({
  events,
  smsEnabled,
  pushEnabled,
  saving,
  onToggleEventChannel,
  onSave,
}: EventConfigTableProps) {
  const t = useT('notifications.events');
  const tShared = useT('notifications.shared');

  const columns: DataTableColumn<EventConfig>[] = [
    {
      header: t('columns.event'),
      primaryOnMobile: true,
      cell: ev => (
        // Event labels live in notifications.events.labels.<event>. All
        // DEFAULT_EVENTS keys are present; any server-added events fall
        // back gracefully via the catch-all translator behaviour.
        <span className="text-sm font-medium text-foreground">
          {translateEventLabel(ev.event, ev.label, t)}
        </span>
      ),
    },
    ...(smsEnabled
      ? [
          {
            header: tShared('channelNames.sms'),
            cell: (ev: EventConfig, idx: number) => (
              <input
                type="checkbox"
                checked={ev.sms}
                onChange={() => onToggleEventChannel(idx, 'sms')}
                className="h-4 w-4 rounded-md border-input text-primary focus:ring-primary"
                aria-label={tShared('channelNames.sms')}
              />
            ),
          },
        ]
      : []),
    ...(pushEnabled
      ? [
          {
            header: tShared('channelNames.pushShort'),
            cell: (ev: EventConfig, idx: number) => (
              <input
                type="checkbox"
                checked={ev.push_notifications}
                onChange={() => onToggleEventChannel(idx, 'push_notifications')}
                className="h-4 w-4 rounded-md border-input text-primary focus:ring-primary"
                aria-label={tShared('channelNames.pushShort')}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-md border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2
            data-setting-id="notifications.events"
            className="text-lg font-semibold text-foreground"
          >
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle')}</p>
        </div>
      </div>

      <DataTable<EventConfig>
        ariaLabel={t('tableLabel')}
        columns={columns}
        rows={events}
        rowKey={ev => ev.event}
      />

      <div className="bg-card rounded-md border border-border px-6 py-4 flex justify-end">
        <Button
          onClick={onSave}
          disabled={saving}
          size="sm"
          className="max-sm:min-h-11 max-sm:px-4"
        >
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
          )}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
