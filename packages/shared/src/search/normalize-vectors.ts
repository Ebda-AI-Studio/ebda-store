/**
 * THE contract for Arabic search folding. `normalizeArabicSearch` (TS) and
 * `public.ebda_ar_norm` (SQL, migration 20261123000100_search_fold_hamza) are BOTH tested against
 * every row (packages/shared/src/search/__tests__ + tests/integration/search-normalize-parity.test.ts).
 * Change a rule => change it in both and add a row here.
 * Rows are real Egyptian shopper spellings (hamza dropped, ta-marbuta as ha, ya without dots).
 */
export const NORMALIZE_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['أحذية', 'احذيه'],
  ['احذيه', 'احذيه'],
  ['مكرونة', 'مكرونه'],
  ['إسدال', 'اسدال'],
  ['آيس كريم', 'ايس كريم'],
  ['ٱلقاهرة', 'القاهره'],
  ['مستشفى', 'مستشفي'],
  ['شنطة جلد', 'شنطه جلد'],
  ['جَزْمَة', 'جزمه'],
  ['عبـــاية', 'عبايه'],
  ['مقاس ٤٢', 'مقاس 42'],
  ['مقاس ۴۲', 'مقاس 42'],
  ['مسئول', 'مسول'], // F7-HAMZA-1: hamza seats unify
  ['مسؤول', 'مسول'],
  ['سؤال', 'سوال'],
  ['سئوال', 'سوال'],
  ['سائل', 'سال'],
  ['ساءل', 'سال'],
  ['\uFEFB تنسى', 'لا تنسي'], // lam-alef ligature (NFKC)
  ['ﻣﺤﻤﺪ', 'محمد'], // Arabic presentation forms (NFKC)
  ['１２٣', '123'], // fullwidth digits (NFKC)
  ['کوتشی', 'كوتشي'],
  ['أحمر', 'احمر'], // alef + combining hamza above
  ['قُطْنٌ ١٠٠٪', 'قطن 100٪'],
  ['3abaya', '3abaya'],
  ['SHOES', 'shoes'],
  ['Abaya   Black', 'abaya black'],
  ['فستان سواريه', 'فستان سواريه'],
  ['  طقم  حريمي  ', 'طقم حريمي'],
  ['iPhone ١٥ Pro', 'iphone 15 pro'],
  ['ى', 'ي'],
  ['ة', 'ه'],
  ['ـ', ''],
  ['', ''],
  ['ا\u0654حمر', 'احمر'], // decomposed alef + U+0654 combining hamza above is stripped
  ['٠١٢٣٤٥٦٧٨٩', '0123456789'], // all Arabic-Indic digits
  ['۰۱۲۳۴۵۶۷۸۹', '0123456789'], // all Persian digits
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'], // full uppercase alphabet
  // Whitespace pin (A1): only [ \t\n\r\u00A0] collapse and only U+0020 is trimmed at the edges.
  // NFKC (F7-HAMZA-1) turns U+2009 and U+3000 into U+0020 first, so they collapse and trim like a plain space; other Unicode spaces that NFKC
  // leaves alone are NOT touched, so SQL btrim(x, ' ') matches byte for byte.
  ['\u2009x\u2009', 'x'], // thin space is a plain space after NFKC
  ['\u3000x\u3000', 'x'], // ideographic space is a plain space after NFKC
  ['\u00A0 x\t\ny\r', 'x y'], // NBSP/tab/LF/CR collapse; trailing collapsed space trimmed
  ['\uFEFFx', '\uFEFFx'], // BOM is not whitespace here
];
