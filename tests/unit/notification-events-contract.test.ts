/**
 * Contract between the admin events table and the API (the page used to fail to save/load its event switches):
 *  - the admin sends `{ events: [{ event, sms, push }] }` with NO `whatsapp` (WhatsApp is the separate Ebda Chat product);
 *    the API schema must accept it instead of answering 400;
 *  - the API answers GET with a MAP `{ [event]: { sms, push } }`; the admin must lay it over its defaults.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {} }));

describe('PUT /notifications/events accepts what the admin sends', () => {
  it('a bulk payload without whatsapp parses', async () => {
    const { bulkEventConfigSchema } = await import('@api/routes/notification.routes');
    const parsed = bulkEventConfigSchema.safeParse({
      events: [
        { event: 'order_confirmed', sms: true, push: false },
        { event: 'order_shipped', sms: false, push: true },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.events[1]).toMatchObject({ event: 'order_shipped', push: true });
  });
});

describe('admin reads the events map', () => {
  it('lays saved switches over the defaults, and accepts the old array shape', async () => {
    const { mergeEventConfigs, DEFAULT_EVENTS } =
      await import('../../apps/admin/src/app/stores/[id]/notifications/_components/types');
    const fromMap = mergeEventConfigs({
      order_shipped: { whatsapp: true, sms: true, push: true },
    })!;
    expect(fromMap).toHaveLength(DEFAULT_EVENTS.length);
    expect(fromMap.find(e => e.event === 'order_shipped')).toMatchObject({
      sms: true,
      push_notifications: true,
    });
    expect(fromMap.find(e => e.event === 'order_confirmed')).toMatchObject({
      sms: false,
      push_notifications: false,
    });
    const fromArray = mergeEventConfigs([{ event: 'order_shipped', sms: true, push: true }])!;
    expect(fromArray.find(e => e.event === 'order_shipped')).toMatchObject({
      push_notifications: true,
    });
    expect(mergeEventConfigs({})).toBeNull();
    expect(mergeEventConfigs(undefined)).toBeNull();
  });
});
