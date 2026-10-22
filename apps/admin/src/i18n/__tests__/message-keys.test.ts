/**
 * next-intl treats "." in a message key as nesting and logs INVALID_KEY for the whole
 * namespace on every render. A dynamic key built from a dotted id (a webhook event type
 * like `order.created`) must be turned into an underscore key at the call site.
 */
import { describe, it, expect } from 'vitest';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT } from '@ebda/shared';
import en from '../messages/en.json';
import ar from '../messages/ar.json';

function dotted(o: unknown, path = ''): string[] {
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [
    ...(k.includes('.') ? [`${path}/${k}`] : []),
    ...dotted(v, `${path}/${k}`),
  ]);
}

const events = (m: unknown) =>
  (m as { webhooks: { events: Record<string, string> } }).webhooks.events;

describe('admin message keys', () => {
  it.each([
    ['en', en],
    ['ar', ar],
  ])('%s has no key containing a dot', (_l, messages) => {
    expect(dotted(messages)).toEqual([]);
  });

  it('every webhook event type has a message in both languages (dots become underscores)', () => {
    const types = [...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT];
    for (const t of types) {
      const key = t.replace('.', '_');
      expect(events(en)[key], `en ${key}`).toBeTruthy();
      expect(events(ar)[key], `ar ${key}`).toBeTruthy();
    }
  });
});
