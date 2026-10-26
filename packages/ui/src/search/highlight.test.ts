import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight';

const marked = (t: string, q: string) =>
  highlightSegments(t, q)
    .filter(s => s.match)
    .map(s => s.text);

describe('highlightSegments', () => {
  it('returns the whole text unmarked for an empty query', () => {
    expect(highlightSegments('حذاء', '')).toEqual([{ text: 'حذاء', match: false }]);
  });
  it('marks one Arabic letter', () => {
    expect(marked('حذاء رياضي', 'ح')).toEqual(['ح']);
  });
  it('folds alef, teh marbuta and yeh but cuts the original spelling', () => {
    expect(marked('أحذية رياضية', 'احذيه')).toEqual(['أحذية']);
    expect(marked('مدرسة', 'مدرسه')).toEqual(['مدرسة']);
    expect(marked('على', 'علي')).toEqual(['على']);
  });
  it('ignores diacritics in the text and the query', () => {
    expect(marked('كِتَاب', 'كتاب')).toEqual(['كِتَاب']);
    expect(marked('كتاب', 'كِتَاب')).toEqual(['كتاب']);
  });
  it('is case-insensitive for English and marks every word and occurrence', () => {
    expect(marked('Red shoes, red laces', 'RED')).toEqual(['Red', 'red']);
    expect(marked('Red shoes', 'sho red')).toEqual(['Red', 'sho']);
  });
  it('reassembles to the original text', () => {
    const t = 'أحذية Nike رياضية';
    expect(
      highlightSegments(t, 'nike ريا')
        .map(s => s.text)
        .join('')
    ).toBe(t);
  });
  it('is injection-inert: markup stays text', () => {
    expect(marked('<b>x</b>', 'b')).toEqual(['b', 'b']);
  });
});
