'use client';

import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
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
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  saving: boolean;
  onToggleEventChannel: (
    eventIndex: number,
    channel: 'whatsapp' | 'sms' | 'push_notifications'
  ) => void;
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
  whatsappEnabled,
  smsEnabled,
  pushEnabled,
  saving,
  onToggleEventChannel,
  onSave,
}: EventConfigTableProps) {
  const t = useT('notifications.events');
  const tShared = useT('notifications.shared');

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle')}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full" aria-label={t('tableLabel')}>
          <thead>
            <tr className="bg-muted border-b border-border">
              <th
                scope="col"
                className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {t('columns.event')}
              </th>
              {whatsappEnabled && (
                <th
                  scope="col"
                  className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center"
                >
                  {tShared('channelNames.whatsapp')}
                </th>
              )}
              {smsEnabled && (
                <th
                  scope="col"
                  className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center"
                >
                  {tShared('channelNames.sms')}
                </th>
              )}
              {pushEnabled && (
                <th
                  scope="col"
                  className="px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center"
                >
                  {tShared('channelNames.pushShort')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.map((ev, idx) => (
              <tr key={ev.event} className="hover:bg-muted">
                <td className="px-6 py-3 text-sm font-medium text-foreground">
                  {/* Event labels live in notifications.events.labels.<event>. All
                      DEFAULT_EVENTS keys are present; any server-added events fall
                      back gracefully via the catch-all translator behaviour. */}
                  {translateEventLabel(ev.event, ev.label, t)}
                </td>
                {whatsappEnabled && (
                  <td className="px-6 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={ev.whatsapp}
                      onChange={() => onToggleEventChannel(idx, 'whatsapp')}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                      aria-label={tShared('channelNames.whatsapp')}
                    />
                  </td>
                )}
                {smsEnabled && (
                  <td className="px-6 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={ev.sms}
                      onChange={() => onToggleEventChannel(idx, 'sms')}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                      aria-label={tShared('channelNames.sms')}
                    />
                  </td>
                )}
                {pushEnabled && (
                  <td className="px-6 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={ev.push_notifications}
                      onChange={() => onToggleEventChannel(idx, 'push_notifications')}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                      aria-label={tShared('channelNames.pushShort')}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-6 py-4 border-t border-border flex justify-end">
        <Button onClick={onSave} disabled={saving} size="sm">
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
          )}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
