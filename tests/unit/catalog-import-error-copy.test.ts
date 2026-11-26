import { describe, expect, it } from 'vitest';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

const errors = (m: unknown): Record<string, string> => {
  const found = (m as { bulk?: { catalogImport?: { errors?: Record<string, string> } } }).bulk
    ?.catalogImport?.errors;
  if (!found) throw new Error('catalog import errors block moved');
  return found;
};

// The review page maps `errorCode` to `errors.<code>`. The two failure causes the merchant can act on differ, and so does what they were charged
// (process-file.ts: an extractor that throws is uncharged; a reply that fails schema validation, BAD_RESPONSE, IS charged).
const KEYS = [
  'AI_UPSTREAM_ERROR',
  'AI_BAD_RESPONSE',
  'BAD_RESPONSE',
  'FILE_UNREADABLE',
  'EXTRACTION_FAILED',
] as const;

describe.each([
  ['en', en],
  ['ar', ar],
])('catalogue import error copy (%s)', (_lang, msgs) => {
  const e = errors(msgs);
  it('every code has its own message (no more single "could not read this file")', () => {
    const texts = KEYS.map(k => e[k]);
    expect(texts.every(t => typeof t === 'string' && t.length > 10)).toBe(true);
    expect(new Set(texts).size).toBe(KEYS.length);
  });
  it('FILE_UNREADABLE blames the file, the upstream code asks for a retry', () => {
    expect(e.FILE_UNREADABLE).not.toBe(e.AI_UPSTREAM_ERROR);
  });
});

describe('what the merchant is told about pages (matches the ledger)', () => {
  it('only BAD_RESPONSE says the pages were counted', () => {
    const counted = (s: string) => /counted\)|اتحسبت/.test(s) && !/no pages|مش هتتحسب/.test(s);
    for (const msgs of [en, ar]) {
      const e = errors(msgs);
      expect(counted(e.BAD_RESPONSE)).toBe(true);
      for (const k of ['AI_UPSTREAM_ERROR', 'AI_BAD_RESPONSE', 'EXTRACTION_FAILED'] as const)
        expect(counted(e[k])).toBe(false);
    }
  });
});
