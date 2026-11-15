/**
 * Wave 2 (plan 4 C2): notification tools. `notification_settings` sets, per event, whether the SMS and the push (orders app) channel fire; it calls
 * `notificationConfigService.upsertEventConfig`, the service behind `PUT /stores/:storeId/notifications/events` (routes/notification.routes.ts,
 * `authorize('store_admin')`; that route has no plan gate: the SMS / push plan gates are on the channel-config routes, which the assistant does not touch).
 * The push toggle of `order_confirmed` IS the new-order phone alert (capability orders.app-alerts); the device subscription itself needs the browser
 * and stays on the screen. Provider credentials (SMS sender keys, WhatsApp) are never accepted: they are entered on the secure screen. WhatsApp is not
 * offered (off for every store on the platform): an existing value is carried through unchanged.
 * Defaults when an event has no row yet: push ON (the orders app pings by default, services/push.service.ts), SMS off (the screen's default).
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { notificationConfigService } from '../../services/notification-config.service';
import { change, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const;
const EVENTS = [
  'order_confirmed',
  'payment_success',
  'payment_failed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
] as [string, ...string[]];
const EVENT_LABELS: Record<string, [string, string]> = {
  order_confirmed: ['طلب جديد', 'New order'],
  payment_success: ['دفع ناجح', 'Payment succeeded'],
  payment_failed: ['دفع فاشل', 'Payment failed'],
  order_shipped: ['الطلب اتشحن', 'Order shipped'],
  order_delivered: ['الطلب اتسلم', 'Order delivered'],
  order_cancelled: ['الطلب اتلغى', 'Order cancelled'],
  order_refunded: ['الطلب اتسترد', 'Order refunded'],
};
type EvEdit = { event: string; sms?: boolean; push?: boolean };
type Args = { events: EvEdit[] };
type Cur = { whatsapp: boolean; sms: boolean; push: boolean };

const base = shape<Args>(
  {
    events: f.list(
      f.obj(
        {
          event: f.enum(EVENTS, 'The event: order_confirmed is the new-order alert.'),
          sms: f.bool(
            'true sends an SMS for this event (needs the SMS plan feature and a connected SMS provider).'
          ),
          push: f.bool('true sends a phone push alert (orders app) for this event.'),
        },
        ['event']
      ),
      { min: 1, max: 7 }
    ),
  },
  ['events']
);
const schema = {
  jsonSchema: base.jsonSchema,
  args: base.args
    .refine(a => a.events.every(e => e.sms !== undefined || e.push !== undefined), {
      message: 'every event needs sms and / or push',
    })
    .refine(a => new Set(a.events.map(e => e.event)).size === a.events.length, {
      message: 'an event appears twice',
    }),
};

const notificationSettings = change<Args>({
  name: 'notification_settings',
  capabilityId: 'notify.channels-events',
  description:
    'Choose which events notify the merchant by SMS and by phone push (orders app): new order (order_confirmed), payment succeeded / failed, shipped, delivered, cancelled, refunded. For the new-order phone sound alert set push on order_confirmed. It never takes SMS or WhatsApp provider credentials (entered on the secure screen) and cannot register a phone: the merchant presses Enable order alerts on the device.',
  schema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'notification.events.updated', resourceType: 'notification_event_config' },
  state: async (ctx, a) => {
    const all = await notificationConfigService.getEventConfigs(ctx.storeId);
    return Object.fromEntries(
      [...new Set(a.events.map(e => e.event))].sort().map(ev => [ev, all[ev] ?? null])
    );
  },
  describe: (_ctx, a, st) => {
    const s = st as Record<string, Cur | null>;
    const rows = [];
    const restore: EvEdit[] = [];
    for (const e of a.events) {
      const cur = s[e.event];
      const before: Cur = cur ?? { whatsapp: false, sms: false, push: true };
      const undo: EvEdit = { event: e.event };
      const [ar, en] = EVENT_LABELS[e.event]!;
      if (e.sms !== undefined) {
        rows.push(row(`${ar}: رسالة SMS`, `${en}: SMS`, before.sms, e.sms));
        undo.sms = before.sms;
      }
      if (e.push !== undefined) {
        rows.push(row(`${ar}: تنبيه على الموبايل`, `${en}: phone alert`, before.push, e.push));
        undo.push = before.push;
      }
      restore.push(undo);
    }
    return {
      summary: pair(
        `هغيّر إشعارات ${a.events.length} حدث`,
        `Change notifications for ${a.events.length} event(s)`
      ),
      rows,
      affectedCount: a.events.length,
      restore: { events: restore },
    };
  },
  run: async (ctx, a, st) => {
    const s = st as Record<string, Cur | null>;
    for (const e of a.events) {
      const cur = s[e.event] ?? { whatsapp: false, sms: false, push: true };
      await notificationConfigService.upsertEventConfig(ctx.storeId, e.event, {
        whatsapp: cur.whatsapp,
        sms: e.sms ?? cur.sms,
        push: e.push ?? cur.push,
      });
    }
    return { updated: a.events.length };
  },
  inverse: (_a, restore) =>
    restore ? { tool: 'notification_settings', args: restore as Rec } : null,
});

/** Wave 2 (plan 4 C2): notification tools. */
export function notificationsTools(): ToolSpec[] {
  return [notificationSettings];
}
