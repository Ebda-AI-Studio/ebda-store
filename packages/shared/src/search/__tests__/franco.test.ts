import { describe, expect, it } from 'vitest';
import { francoSpellings, francoWordVariants } from '../franco';

/**
 * Recall set (G72): [Arabic product word, spellings shoppers type]. A query is "found" when it is a
 * substring of one generated variant (search is word-AND over substrings of the stored words).
 * The set is hand-written from how Egyptian shoppers spell, NOT fitted to the generator's output.
 */
const RECALL: Array<[string, string[]]> = [
  ['إسورة', ['eswera', 'aswera', 'eswra', 'aswara', 'asora', 'eswara']],
  ['اسورة', ['eswera', 'aswera', 'aswara']],
  ['شنطة', ['shanta', 'shanta', 'shanta', 'shenta']],
  ['عباية', ['3abaya', 'abaya', 'abaia', '3abaia']],
  ['جزمة', ['gazma', 'gezma', 'gozma']],
  ['كوتشي', ['kotshy', 'kotshi', 'kutshi', 'koshy']],
  ['حلق', ['7alaq', '7ala2', 'halaq', 'hala2']],
  ['خاتم', ['5atem', 'khatem', 'khatam', '5atam']],
  ['سلسلة', ['selsela', 'silsila', 'selsla', 'silsela']],
  ['طرحة', ['tarha', 'terha', '6arha']],
  ['فستان', ['fostan', 'fustan', 'fesstan', 'fostan']],
  ['قميص', ['2ameis', 'a2mis', 'qamis', '2amis']],
  ['بنطلون', ['pantalon', 'bantalon', 'bantaloon']],
  ['ساعة', ['sa3a', 'saa', 'sa3ah']],
  ['نظارة', ['nadara', 'nazara', 'nazzara']],
  ['حقيبة', ['7a2iba', 'haqiba', 'ha2eba']],
  ['محفظة', ['ma7fa6a', 'mahfaza', 'mahfazah', 'mo7faza']],
  ['جاكيت', ['jacket', 'gaket', 'jaket']],
  ['بيجامة', ['bijama', 'pijama', 'bejama', 'bigama']],
  ['شبشب', ['shebsheb', 'shibshib', 'shobshob']],
];

describe('francoSpellings', () => {
  it('gives إسورة the spelling a shopper types, not only the model', () => {
    expect(francoWordVariants('إسورة')).toContain('eswera');
  });

  it('drops the definite article and diacritics, keeps at most twelve spellings per word', () => {
    const v = francoWordVariants('الإِسْوِرَة');
    expect(v).toContain('eswera');
    expect(v.length).toBeLessThanOrEqual(12);
  });

  it('re-spells only Arabic words: a Latin name yields nothing', () => {
    expect(francoSpellings('Silver bracelet', null)).toEqual([]);
  });

  it('covers the first three distinct Arabic words across both names and ignores 2-letter words', () => {
    const out = francoSpellings('إسورة فضة', 'إسورة من الشط جميلة');
    expect(out).toContain('eswera');
    expect(out.length).toBeLessThanOrEqual(14);
  });

  it('recall floor on the hand-written shopper set (rules alone; the model adds the loanwords and odd spellings)', () => {
    let hit = 0;
    let total = 0;
    const missed: string[] = [];
    const unreachable: string[] = [];
    for (const [word, queries] of RECALL) {
      const variants = francoWordVariants(word);
      let any = false;
      for (const q of queries) {
        total++;
        if (variants.some(v => v.includes(q))) {
          hit++;
          any = true;
        } else missed.push(`${word}:${q}`);
      }
      if (!any) unreachable.push(word);
    }
    // eslint-disable-next-line no-console
    console.info(`franco recall ${hit}/${total}; missed ${missed.join(' ')}`);
    expect(unreachable.length).toBeLessThanOrEqual(9);
    // Measured 39/73 (53%) at this cap; a regression below 50% fails.
    expect(hit / total).toBeGreaterThanOrEqual(0.5);
  });
});
