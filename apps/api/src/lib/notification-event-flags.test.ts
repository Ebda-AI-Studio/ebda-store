/** STORE-QA-62: the admin sends only sms/push; that must validate (was 400) and must not flip the stored WhatsApp flag. */
import { describe, it, expect } from 'vitest';

import { eventConfigShape, mergeEventFlags } from './notification-event-flags';

describe('event config payload', () => {
  it('accepts the admin payload without `whatsapp`', () => {
    const r = eventConfigShape.safeParse({ event: 'order_confirmed', sms: true, push: false });
    expect(r.success).toBe(true);
  });
  it('keeps unsent flags from the stored row, defaults a new event to false', () => {
    const parsed = eventConfigShape.parse({ event: 'order_confirmed', sms: true });
    const stored = { order_confirmed: { whatsapp: true, sms: false, push: true } };
    expect(mergeEventFlags(stored, parsed)).toEqual({ whatsapp: true, sms: true, push: true });
    expect(mergeEventFlags({}, parsed)).toEqual({ whatsapp: false, sms: true, push: false });
  });
  it('maps push_notifications to push', () => {
    expect(eventConfigShape.parse({ event: 'e', push_notifications: true }).push).toBe(true);
  });
});
