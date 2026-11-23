import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT, webhookUrlShapeError } from '@ebda/shared';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/** QA-83 / QA-84: every webhook event type and every URL refusal has Arabic AND English copy (the class, not one key). */
const events = [...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT].map(e => e.replace(/\./g, '_'));
const probes = [
  'nope',
  'http://example.com/x',
  'https://u:p@example.com/x',
  'https://example.com:8443/x',
  'https://127.0.0.1/x',
  'https://intranet/x',
  'https://foo.local/x',
  'https://api.ebda.app/health',
];

describe('webhook copy', () => {
  for (const [name, m] of [
    ['ar', ar],
    ['en', en],
  ] as const) {
    it(`${name}: every event type has a label`, () => {
      const labels = m.webhooks.events as Record<string, string>;
      for (const e of events) expect(labels[e], e).toBeTruthy();
    });
    it(`${name}: every URL refusal reason has a message`, () => {
      const msgs = m.webhooks.urlError as Record<string, string>;
      for (const p of probes) {
        const code = webhookUrlShapeError(p);
        expect(code, p).not.toBeNull();
        expect(msgs[code!], `${p} -> ${code}`).toBeTruthy();
      }
    });
  }
  it('an Ebda host is refused with the platform-host reason', () => {
    expect(webhookUrlShapeError('https://api.ebda.app/health')).toBe('platform_host_not_allowed');
  });
});
