/**
 * Franco-Arabic spellings of a product's own Arabic words (G72). The model writes search words
 * for each product, but a model is not deterministic: "eswera" was generated for one bracelet
 * (إسورة) and not for the other, so a shopper typing it found 1 of 2. These spellings are
 * computed from the Arabic name itself, so every product gets the common ones, with zero AI
 * spend, in generation and in the backfill. Search is word-AND over substrings, so one list of
 * variants per word is enough: a shopper's multi-word query matches word by word.
 *
 * Pure and deterministic; never invents a word, only re-spells the ones the merchant wrote.
 */

const TASHKEEL = /[ً-ٰٟـ]/g;
const ARABIC_WORD = /[ء-ي]+/g;
const MAX_WORDS = 3;
const MAX_VARIANTS = 12;
/** All words of one product together, so the stored 30-term / 500-char budget is never crowded out. */
const MAX_TOTAL = 14;
const MIN_WORD_LETTERS = 3;

interface Profile {
  /** Letter و */
  w: string;
  /** Letter ي / ى */
  y: string;
  /** Vowel put between two consonants that have none (Egyptian speech: "eswera", "shanta"). */
  ins: string;
  /** Which of the vowel-less consonant gaps take it: all of them, or only the Nth (0-based). */
  gap: 'all' | number | 'none';
  /** Word-final ة */
  ta: string;
  /** Word-initial إ / أ / آ / ا */
  alef: string;
  /** Letters ح خ ع ق: digit style (7 5 3 2) or letter style (h kh a q) */
  digits: boolean;
  /** Letter ق */
  q: string;
}

/**
 * Spelling styles, most common first: the vowel a shopper puts between consonants (and where), the
 * way و / ي / ا are written, digits vs letters for ح خ ع ق. The cross product is built once; the
 * per-word cap keeps the earliest distinct results, so the likeliest spellings always make it.
 */
const PROFILES: Profile[] = (() => {
  const out: Profile[] = [];
  const insChoices: Array<[string, Profile['gap']]> = [
    ['e', 'all'],
    ['a', 0],
    ['a', 'all'],
    ['e', 0],
    ['', 'none'],
    ['a', 1],
    ['o', 0],
  ];
  for (const [ins, gap] of insChoices)
    for (const wy of [
      ['w', 'y'],
      ['o', 'i'],
    ])
      for (const digits of [true, false])
        for (const q of ['2', 'q'])
          for (const [alef, ta] of [
            ['e', 'a'],
            ['a', 'ah'],
          ])
            out.push({ w: wy[0], y: wy[1], ins, gap, ta, alef, digits, q });
  return out;
})();

const CONSONANTS: Record<string, string> = {
  ب: 'b',
  ت: 't',
  ث: 's',
  ج: 'g',
  ح: '7',
  خ: '5',
  د: 'd',
  ذ: 'z',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: '3',
  غ: 'gh',
  ف: 'f',
  ق: '2',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  ء: '2',
};

/** Letter-style spellings of the four letters shoppers also write as digits. */
const LETTER_STYLE: Record<string, string> = { ح: 'h', خ: 'kh', ع: '' };

function spell(word: string, p: Profile): string {
  let out = '';
  let prevConsonant = false;
  let gapIndex = -1;
  const chars = [...word];
  chars.forEach((ch, i) => {
    const first = i === 0;
    const last = i === chars.length - 1;
    let piece: string;
    let consonant = false;
    let glide = false;
    if (ch === 'ا' || ch === 'أ' || ch === 'إ' || ch === 'آ') piece = first ? p.alef : 'a';
    else if (ch === 'و') {
      piece = p.w;
      consonant = p.w === 'w';
      glide = consonant;
    } else if (ch === 'ي') {
      piece = p.y;
      consonant = p.y === 'y';
      glide = consonant;
    } else if (ch === 'ى') piece = 'a';
    else if (ch === 'ة') piece = p.ta;
    else if (ch === 'ئ' || ch === 'ؤ') piece = '2';
    else if (ch === 'ق') {
      piece = p.q;
      consonant = true;
    } else {
      piece = (p.digits ? undefined : LETTER_STYLE[ch]) ?? CONSONANTS[ch] ?? '';
      consonant = piece !== '';
    }
    if (!piece) return;
    // Two consonants in a row take the spoken vowel between them; the last letter never does.
    if (consonant && !glide && prevConsonant && p.gap !== 'none') {
      gapIndex++;
      if (p.gap === 'all' || p.gap === gapIndex) out += p.ins;
    }
    out += piece;
    prevConsonant = consonant;
  });
  return out;
}

/** Common Latin spellings of one Arabic word (definite article dropped), at most `max` (default MAX_VARIANTS). */
export function francoWordVariants(word: string, max = MAX_VARIANTS): string[] {
  const bare = word.replace(TASHKEEL, '').replace(/^ال(?=[ء-ي]{3})/, '');
  if ([...bare].length < MIN_WORD_LETTERS) return [];
  const seen = new Set<string>();
  for (const p of PROFILES) {
    const v = spell(bare, p);
    if (v.length >= 3) seen.add(v);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Franco spellings for the Arabic words of a product's names (first MAX_WORDS distinct words).
 * Latin-only names yield nothing: their words are already typed in Latin letters.
 */
export function francoSpellings(...names: Array<string | null | undefined>): string[] {
  const words: string[] = [];
  for (const name of names) {
    for (const m of (name ?? '').replace(TASHKEEL, '').matchAll(ARABIC_WORD)) {
      if (!words.includes(m[0])) words.push(m[0]);
    }
  }
  const picked = words.slice(0, MAX_WORDS);
  const each = Math.max(1, Math.floor(MAX_TOTAL / Math.max(1, picked.length)));
  const out: string[] = [];
  for (const w of picked) {
    for (const v of francoWordVariants(w, each)) if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_TOTAL);
}
