/**
 * Issue #1933 — the AI narration body must follow the admin's active
 * locale (the API already returns both `en` and `ar`), not always render
 * the English variant regardless of locale.
 */
import { describe, it, expect } from 'vitest';
import { pickNarration } from '../narration';

describe('pickNarration', () => {
  const narration = { en: 'Sales are up 12%.', ar: 'ارتفعت المبيعات بنسبة 12%.' };

  it('returns the English body for the en locale', () => {
    expect(pickNarration(narration, 'en')).toBe('Sales are up 12%.');
  });

  it('returns the Arabic body for the ar locale', () => {
    expect(pickNarration(narration, 'ar')).toBe('ارتفعت المبيعات بنسبة 12%.');
  });

  it('falls back to English on ar locale when no Arabic variant exists yet (legacy row)', () => {
    expect(pickNarration({ en: 'Sales are up 12%.', ar: '' }, 'ar')).toBe('Sales are up 12%.');
  });

  it('shows an ar-only row on the en locale instead of hiding the insight (issue 2179)', () => {
    expect(pickNarration({ en: '', ar: 'ارتفعت المبيعات.' }, 'en')).toBe('ارتفعت المبيعات.');
  });

  it('returns undefined when there is no narration at all', () => {
    expect(pickNarration(null, 'ar')).toBeUndefined();
    expect(pickNarration(undefined, 'en')).toBeUndefined();
  });
});
