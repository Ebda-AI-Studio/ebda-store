/**
 * Egypt address mapping shared by the carrier adapters (shipping batch, plan section 3.1:
 * "address mapping is mandatory").
 *
 * Every carrier names places differently (Bosta cityCode + zone/district ids, ShipBlu zone ids,
 * Mylerz zone / sub-zone codes, Aramex city names), and a storefront address is free text in two
 * languages. This module owns the carrier-independent half:
 *
 *   - the 27 governorates, with the spellings carriers and customers actually use, so any of
 *     "القاهرة", "Cairo", "Al Qahirah", "محافظة القاهرة" resolves to one key;
 *   - `normalizeName`: Arabic-aware folding (alef / ya / ta-marbuta variants, diacritics, tatweel,
 *     "محافظة" / "governorate" prefixes) so names compare by meaning, not by spelling;
 *   - `pickByName`: the one matching rule adapters use against a carrier's own location list:
 *     exact folded match first (including each side of a bilingual "عربي - English" label), then
 *     a unique containment match; ambiguity is NOT resolved by guessing (null = NEEDS_MAPPING).
 *
 * The per-carrier id lookups (which need the merchant's key) stay in each adapter.
 */

export interface EgyptGovernorate {
  key: string;
  en: string;
  ar: string;
  aliases: readonly string[];
}

export const EGYPT_GOVERNORATES: readonly EgyptGovernorate[] = [
  {
    key: 'cairo',
    en: 'Cairo',
    ar: 'القاهرة',
    aliases: ['Al Qahirah', 'El Qahira', 'Greater Cairo', 'New Cairo'],
  },
  { key: 'giza', en: 'Giza', ar: 'الجيزة', aliases: ['Al Jizah', 'El Giza', 'Gizeh'] },
  {
    key: 'alexandria',
    en: 'Alexandria',
    ar: 'الإسكندرية',
    aliases: ['Al Iskandariyah', 'Alex', 'الاسكندريه'],
  },
  {
    key: 'qalyubia',
    en: 'Qalyubia',
    ar: 'القليوبية',
    aliases: ['Qalubiya', 'Kalyoubia', 'Qaliubiya', 'Al Qalyubiyah'],
  },
  {
    key: 'sharqia',
    en: 'Sharqia',
    ar: 'الشرقية',
    aliases: ['Sharkia', 'Ash Sharqiyah', 'Al Sharqia'],
  },
  {
    key: 'dakahlia',
    en: 'Dakahlia',
    ar: 'الدقهلية',
    aliases: ['Daqahliyah', 'Ad Daqahliyah', 'Dakahliya'],
  },
  {
    key: 'gharbia',
    en: 'Gharbia',
    ar: 'الغربية',
    aliases: ['Gharbiyya', 'Al Gharbiyah', 'Gharbiya'],
  },
  {
    key: 'monufia',
    en: 'Monufia',
    ar: 'المنوفية',
    aliases: ['Menoufia', 'Minufiyah', 'Al Minufiyah'],
  },
  {
    key: 'beheira',
    en: 'Beheira',
    ar: 'البحيرة',
    aliases: ['Buhayrah', 'El Beheira', 'Al Buhayrah'],
  },
  {
    key: 'kafr-el-sheikh',
    en: 'Kafr El Sheikh',
    ar: 'كفر الشيخ',
    aliases: ['Kafr el-Sheikh', 'Kafr ash Shaykh', 'Kafrelsheikh'],
  },
  { key: 'damietta', en: 'Damietta', ar: 'دمياط', aliases: ['Domyat', 'Dumyat'] },
  {
    key: 'port-said',
    en: 'Port Said',
    ar: 'بورسعيد',
    aliases: ['Bur Said', 'PortSaid', 'بور سعيد'],
  },
  {
    key: 'ismailia',
    en: 'Ismailia',
    ar: 'الإسماعيلية',
    aliases: ['Ismailiyah', 'Al Isma’iliyah', 'الاسماعيليه'],
  },
  { key: 'suez', en: 'Suez', ar: 'السويس', aliases: ['As Suways', 'El Suez'] },
  {
    key: 'north-sinai',
    en: 'North Sinai',
    ar: 'شمال سيناء',
    aliases: ['Shamal Sina', 'Ash Shamal Sina'],
  },
  {
    key: 'south-sinai',
    en: 'South Sinai',
    ar: 'جنوب سيناء',
    aliases: ['Janub Sina', 'Sharm El Sheikh'],
  },
  {
    key: 'red-sea',
    en: 'Red Sea',
    ar: 'البحر الأحمر',
    aliases: ['Al Bahr al Ahmar', 'Hurghada', 'البحر الاحمر'],
  },
  { key: 'fayoum', en: 'Fayoum', ar: 'الفيوم', aliases: ['Faiyum', 'Al Fayyum', 'El Fayoum'] },
  {
    key: 'beni-suef',
    en: 'Beni Suef',
    ar: 'بني سويف',
    aliases: ['Bani Suwayf', 'Beni Sweif', 'Banisuef'],
  },
  { key: 'minya', en: 'Minya', ar: 'المنيا', aliases: ['Minia', 'Al Minya', 'El Minya'] },
  { key: 'assiut', en: 'Assiut', ar: 'أسيوط', aliases: ['Asyut', 'Assuit', 'اسيوط'] },
  { key: 'sohag', en: 'Sohag', ar: 'سوهاج', aliases: ['Suhaj', 'Sohaj'] },
  { key: 'qena', en: 'Qena', ar: 'قنا', aliases: ['Qina', 'Kena'] },
  { key: 'luxor', en: 'Luxor', ar: 'الأقصر', aliases: ['Al Uqsur', 'El Uqsur', 'الاقصر'] },
  { key: 'aswan', en: 'Aswan', ar: 'أسوان', aliases: ['Assuan', 'اسوان'] },
  {
    key: 'new-valley',
    en: 'New Valley',
    ar: 'الوادي الجديد',
    aliases: ['Al Wadi al Jadid', 'El Wadi El Gedid', 'Kharga'],
  },
  {
    key: 'matrouh',
    en: 'Matrouh',
    ar: 'مطروح',
    aliases: ['Matruh', 'Marsa Matrouh', 'Mersa Matruh'],
  },
];

/**
 * Fold a place name for comparison: lower-case Latin, Arabic letter variants merged, diacritics
 * and tatweel removed, administrative prefixes dropped, punctuation and spacing collapsed.
 */
export function normalizeName(input: string): string {
  let s = String(input ?? '')
    .normalize('NFKD')
    .toLowerCase();
  s = s
    .replace(/[ً-ٰٟـ]/g, '') // harakat, superscript alef, tatweel
    .replace(/[أإآٱ]/g, 'ا') // alef variants -> alef
    .replace(/ى/g, 'ي') // alef maksura -> ya
    .replace(/ة/g, 'ه') // ta marbuta -> ha
    .replace(/ؤ/g, 'و') // hamza on waw -> waw
    .replace(/ئ/g, 'ي') // hamza on ya -> ya
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)); // Arabic-Indic digits
  s = s
    .replace(/\bgovernorate\b|\bgovernment\b|\bgov\.?\b/g, ' ')
    .replace(/^\s*(محافظه|محافظة)\s+/u, ' ')
    .replace(/\b(al|el)[\s-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // the Arabic definite article on the first word ("القاهره" and "قاهره" are one place)
  s = s.replace(/^ال(?=\S{2})/u, '');
  return s;
}

const GOV_INDEX: Map<string, EgyptGovernorate> = (() => {
  const m = new Map<string, EgyptGovernorate>();
  for (const g of EGYPT_GOVERNORATES) {
    for (const name of [g.en, g.ar, ...g.aliases]) m.set(normalizeName(name), g);
  }
  return m;
})();

/** The governorate a free-text name refers to, or null. */
export function canonicalGovernorate(input: string | undefined | null): EgyptGovernorate | null {
  if (!input) return null;
  const n = normalizeName(input);
  if (!n) return null;
  return GOV_INDEX.get(n) ?? null;
}

/** Each comparable folded name of a carrier label; "القاهرة - Cairo" gives both sides and the whole. */
function foldedNames(label: string): string[] {
  const parts = String(label ?? '')
    .split(/\s+[-–—|/]\s+/)
    .map(normalizeName)
    .filter(Boolean);
  const whole = normalizeName(label);
  return [...new Set([whole, ...parts])];
}

/**
 * The single item whose name(s) match `query`: exact folded equality (either side of a bilingual
 * label) beats a unique containment match. More than one candidate at the same tier is ambiguous
 * and answers null: an adapter must ask the merchant (NEEDS_MAPPING), never guess a location id.
 */
export function pickByName<T>(
  items: readonly T[],
  namesOf: (item: T) => string[],
  query: string | undefined | null
): T | null {
  const q = normalizeName(query ?? '');
  if (!q) return null;
  const exact: T[] = [];
  const partial: T[] = [];
  for (const item of items) {
    const names = namesOf(item).flatMap(foldedNames);
    if (names.includes(q)) exact.push(item);
    else if (q.length >= 3 && names.some(n => n.length >= 3 && (n.includes(q) || q.includes(n)))) {
      partial.push(item);
    }
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  return partial.length === 1 ? partial[0] : null;
}
