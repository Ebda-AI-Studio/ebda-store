/**
 * Ruling B1-13: when the demo showroom refuses a form (403 DEMO_STORE), the visitor reads one
 * plain sentence in their language; every other failure keeps the form's own message.
 */
import { describe, it, expect } from 'vitest';
import { demoRefusalText } from '../../apps/web/src/lib/demo-refusal';

const ar = (_en: string, a: string) => a;
const en = (e: string) => e;

describe('demoRefusalText', () => {
  it('DEMO_STORE reads as the demo sentence, Arabic first', () => {
    expect(demoRefusalText({ code: 'DEMO_STORE' }, ar)).toBe(
      'هذا متجر تجريبي — هذه الخاصية مغلقة هنا'
    );
    expect(demoRefusalText({ code: 'DEMO_STORE' }, en)).toBe(
      'This is a demo store: this is turned off here'
    );
  });
  it('any other error, or none, is not a demo refusal', () => {
    for (const e of [{ code: 'VALIDATION_ERROR' }, { code: 'RATE_LIMITED' }, {}, null, undefined])
      expect(demoRefusalText(e, ar)).toBeNull();
  });
});
