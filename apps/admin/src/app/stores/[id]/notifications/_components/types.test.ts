import { describe, it, expect } from 'vitest';
import { mergeStoredEvents, DEFAULT_EVENTS } from './types';

describe('mergeStoredEvents (STORE-QA-62)', () => {
  it('folds the API record over the defaults so a saved toggle survives a reload', () => {
    const out = mergeStoredEvents({ order_confirmed: { whatsapp: false, sms: true, push: false } });
    expect(out).toHaveLength(DEFAULT_EVENTS.length);
    expect(out.find(e => e.event === 'order_confirmed')).toMatchObject({
      sms: true,
      push_notifications: false,
    });
    expect(out.find(e => e.event === 'order_shipped')?.sms).toBe(false);
  });
  it('still reads a legacy array and an empty value', () => {
    expect(
      mergeStoredEvents([{ event: 'order_shipped', sms: false, push_notifications: true }]).find(
        e => e.event === 'order_shipped'
      )?.push_notifications
    ).toBe(true);
    expect(mergeStoredEvents({})).toEqual(DEFAULT_EVENTS);
  });
});
