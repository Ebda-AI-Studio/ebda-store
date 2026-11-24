/**
 * Contract between the admin events table and the API (the page used to fail to save its event switches; the read side is covered by types.test.ts):
 *  - the admin sends `{ events: [{ event, sms, push }] }` with NO `whatsapp` (WhatsApp is the separate Ebda Chat product);
 *    the API schema must accept it instead of answering 400;
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
