import { describe, it, expect } from 'vitest';
import { detectCitation, type EngineAnswer } from '../provider';

const baseAnswer = (overrides: Partial<EngineAnswer> = {}): EngineAnswer => ({
  text: 'Some generic answer text.',
  citedUrls: [],
  ...overrides,
});

describe('detectCitation', () => {
  it('cites the store when its domain host appears in citedUrls, with 1-based rank', () => {
    const result = detectCitation(
      { domain: 'example.com' },
      baseAnswer({
        citedUrls: [
          'https://competitor-a.com/page',
          'https://example.com/best-widgets',
          'https://competitor-b.com',
        ],
      })
    );
    expect(result.cited).toBe(true);
    expect(result.rank).toBe(2);
  });

  it('cites via a brand mention in the answer text when no domain match exists', () => {
    const result = detectCitation(
      { domain: 'example.com', brand: 'Widget Co' },
      baseAnswer({
        text: 'For quality widgets, Widget Co is a popular choice among shoppers.',
        citedUrls: ['https://competitor-a.com'],
      })
    );
    expect(result.cited).toBe(true);
    expect(result.rank).toBeUndefined();
  });

  it('brand match is case-insensitive', () => {
    const result = detectCitation(
      { domain: 'example.com', brand: 'Widget Co' },
      baseAnswer({ text: 'widget co ships fast.', citedUrls: [] })
    );
    expect(result.cited).toBe(true);
  });

  it('captures competitor URLs as the cited hosts that are not the store', () => {
    const result = detectCitation(
      { domain: 'example.com' },
      baseAnswer({
        citedUrls: [
          'https://competitor-a.com/page',
          'https://example.com/best-widgets',
          'https://competitor-b.com',
        ],
      })
    );
    expect(result.competitorUrls).toEqual([
      'https://competitor-a.com/page',
      'https://competitor-b.com',
    ]);
  });

  it('normalizes www. and case when comparing hosts', () => {
    const result = detectCitation(
      { domain: 'WWW.Example.com' },
      baseAnswer({ citedUrls: ['HTTPS://example.com/x'] })
    );
    expect(result.cited).toBe(true);
    expect(result.rank).toBe(1);
    expect(result.competitorUrls).toEqual([]);
  });

  it('normalizes a bare domain (no scheme) the same as a full URL', () => {
    const result = detectCitation(
      { domain: 'example.com' },
      baseAnswer({ citedUrls: ['www.example.com'] })
    );
    expect(result.cited).toBe(true);
  });

  it('returns cited=false with empty competitorUrls when citedUrls is empty and no brand given', () => {
    const result = detectCitation({ domain: 'example.com' }, baseAnswer({ citedUrls: [] }));
    expect(result).toEqual({ cited: false, competitorUrls: [] });
  });

  it('does not throw on a null store', () => {
    expect(() => detectCitation(null, baseAnswer({ citedUrls: ['https://x.com'] }))).not.toThrow();
    const result = detectCitation(null, baseAnswer({ citedUrls: ['https://x.com'] }));
    expect(result.cited).toBe(false);
  });

  it('does not throw on a null/undefined answer', () => {
    expect(() => detectCitation({ domain: 'example.com' }, null)).not.toThrow();
    expect(() => detectCitation({ domain: 'example.com' }, undefined)).not.toThrow();
    expect(detectCitation({ domain: 'example.com' }, null)).toEqual({
      cited: false,
      competitorUrls: [],
    });
  });

  it('does not throw on malformed citedUrls (non-array, non-string entries, garbage strings)', () => {
    const malformed = baseAnswer({
      citedUrls: ['not a url', 123 as unknown as string, null as unknown as string, ''],
    });
    expect(() => detectCitation({ domain: 'example.com' }, malformed)).not.toThrow();
    const result = detectCitation({ domain: 'example.com' }, malformed);
    expect(result.cited).toBe(false);
    expect(result.competitorUrls).toEqual([]);
  });

  it('does not throw when citedUrls is missing entirely (malformed shape)', () => {
    const malformed = { text: 'hi' } as unknown as EngineAnswer;
    expect(() => detectCitation({ domain: 'example.com' }, malformed)).not.toThrow();
    expect(detectCitation({ domain: 'example.com' }, malformed)).toEqual({
      cited: false,
      competitorUrls: [],
    });
  });

  it('does not throw when domain is null and citedUrls has entries (all become competitors)', () => {
    const result = detectCitation(
      { domain: null },
      baseAnswer({ citedUrls: ['https://competitor-a.com', 'https://competitor-b.com'] })
    );
    expect(result.cited).toBe(false);
    expect(result.competitorUrls).toEqual(['https://competitor-a.com', 'https://competitor-b.com']);
  });

  it('dedupes repeated competitor URLs', () => {
    const result = detectCitation(
      { domain: 'example.com' },
      baseAnswer({ citedUrls: ['https://competitor-a.com', 'https://competitor-a.com'] })
    );
    expect(result.competitorUrls).toEqual(['https://competitor-a.com']);
  });
});
