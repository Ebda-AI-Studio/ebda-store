/**
 * Wave 2 (plan 4 C2): notification tools. `notification_settings` sets, per event, whether the SMS and the push channel fire; it calls
 * `notificationConfigService.upsertEventConfig`, the service behind `PUT /stores/:storeId/notifications/events` (routes/notification.routes.ts,
 * `authorize('store_admin')`; that route has no plan gate: the SMS / push plan gates are on the channel-config routes, which the assistant does not touch).
 *
 * WHO RECEIVES IT (services/notification-dispatcher.service.ts, read 2026-11-15): every event in this table is a message to the merchant's
 * CUSTOMERS, not to the merchant. SMS goes to `recipientPhone: data.customerPhone` and each SMS is billed to the merchant (segments are logged);
 * push goes through `pushService.sendToStore` to every device subscribed to the store (the shoppers' browsers and the merchant's orders app).
 * The cart-abandoned and back-in-stock events are promotional: their SMS also needs the shopper's recorded SMS consent. So the tool is a
 * confirm-class `messagesCustomers` tool and every card row says who gets the message and who pays. The one merchant-facing exception is the
 * new-order phone alert: the orders app is pinged when `order_confirmed` push is on (services/push.service.ts sendToOrdersApp).
 * The event names are the dispatcher's own (`NotificationEvent` in @ebda/shared); a missing row means SMS on and push on (getEventConfig).
 * Provider credentials (SMS sender keys, WhatsApp) are never accepted: they are entered on the secure screen. WhatsApp is not offered (off for
 * every store on the platform): an existing value is carried through unchanged.
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { notificationConfigService } from '../../services/notification-config.service';
import { change, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const;
const EVENTS = [
  'order_confirmed',
  'payment_success',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'refund_processed',
  'cart_abandoned_step1',
  'cart_abandoned_step2',
  'cart_abandoned_step3',
  'back_in_stock',
] as [string, ...string[]];
const PROMOTIONAL = new Set([
  'cart_abandoned_step1',
  'cart_abandoned_step2',
  'cart_abandoned_step3',
  'back_in_stock',
]);
const EVENT_LABELS: Record<string, [string, string]> = {
  order_confirmed: ['تأكيد الطلب', 'Order confirmed'],
  payment_success: ['دفع ناجح', 'Payment succeeded'],
  order_shipped: ['الطلب اتشحن', 'Order shipped'],
  order_delivered: ['الطلب اتسلم', 'Order delivered'],
  order_cancelled: ['الطلب اتلغى', 'Order cancelled'],
  refund_processed: ['تم رد المبلغ', 'Refund processed'],
  cart_abandoned_step1: ['تذكير بالسلة المتروكة (الأول)', 'Abandoned cart reminder 1'],
  cart_abandoned_step2: ['تذكير بالسلة المتروكة (التاني)', 'Abandoned cart reminder 2'],
  cart_abandoned_step3: ['تذكير بالسلة المتروكة (التالت)', 'Abandoned cart reminder 3'],
  back_in_stock: ['المنتج رجع متاح', 'Back in stock'],
};
type EvEdit = { event: string; sms?: boolean; push?: boolean };
type Args = { events: EvEdit[] };
type Cur = { whatsapp: boolean; sms: boolean; push: boolean };
/** The dispatcher's default for an event with no row. */
const DEFAULT_CUR: Cur = { whatsapp: false, sms: true, push: true };

const base = shape<Args>(
  {
    events: f.list(
      f.obj(
        {
          event: f.enum(
            EVENTS,
            'The event. order_confirmed also pings the merchant orders app when push is on.'
          ),
          sms: f.bool(
            'true sends an SMS for this event (needs the SMS plan feature and a connected SMS provider).'
          ),
          push: f.bool(
            'true sends a push alert to the devices subscribed to the store (shoppers and the orders app) for this event.'
          ),
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
    "Choose, per event, whether the store sends an SMS and / or a push alert. These are messages to the merchant's CUSTOMERS: an SMS goes to the customer's phone and EVERY SMS is charged to the merchant; push goes to the devices subscribed to the store (shoppers and the orders app). Events: order_confirmed, payment_success, order_shipped, order_delivered, order_cancelled, refund_processed, cart_abandoned_step1-3 and back_in_stock (these four also need the shopper's SMS consent). push on order_confirmed also pings the merchant's orders app. A missing setting means SMS on and push on. It never takes SMS or WhatsApp credentials (entered on the secure screen) and cannot register a phone. The merchant always confirms.",
  policy: 'confirm',
  messagesCustomers: true,
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
      const before: Cur = cur ?? DEFAULT_CUR;
      const undo: EvEdit = { event: e.event };
      const [ar, en] = EVENT_LABELS[e.event]!;
      if (e.sms !== undefined) {
        rows.push(
          row(
            `${ar}: رسالة SMS للعميل على تليفونه، وكل رسالة بتتحاسب عليك${PROMOTIONAL.has(e.event) ? ' (وبشرط موافقة العميل على الرسائل)' : ''}`,
            `${en}: SMS to your customer's phone, each message is charged to you${PROMOTIONAL.has(e.event) ? " (only with the shopper's SMS consent)" : ''}`,
            before.sms,
            e.sms
          )
        );
        undo.sms = before.sms;
      }
      if (e.push !== undefined) {
        rows.push(
          row(
            `${ar}: تنبيه فوري على الأجهزة المشتركة في متجرك (العملاء وتطبيق الطلبات)`,
            `${en}: push alert to devices subscribed to your store (shoppers and the orders app)`,
            before.push,
            e.push
          )
        );
        undo.push = before.push;
      }
      restore.push(undo);
    }
    return {
      summary: pair(
        `هغيّر الرسائل اللي بتتبعت لعملائك في ${a.events.length} حدث. الرسائل النصية بتروح لعملائك وكل رسالة بتتحاسب عليك.`,
        `Change the messages sent to your customers for ${a.events.length} event(s). SMS goes to your customers and each message is charged to you.`
      ),
      rows,
      affectedCount: a.events.length,
      restore: { events: restore },
    };
  },
  run: async (ctx, a, st) => {
    const s = st as Record<string, Cur | null>;
    for (const e of a.events) {
      const cur = s[e.event] ?? DEFAULT_CUR;
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
