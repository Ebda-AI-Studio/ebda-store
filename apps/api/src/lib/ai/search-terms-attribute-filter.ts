/**
 * Deterministic guard against INVENTED attributes in AI search words (search program P1, Task 8
 * review I5; Ruling SEARCH-T8-2). The prompt asks the model not to add a gender, an age group or a
 * season the product data does not state, but the live check showed it still does about once in
 * ten products ("بوت رجالي" on a boot with no gender). A wrong attribute makes the product match
 * a query it should not, so the rule is enforced here, not only asked for.
 *
 * Concept groups, not single words: a generated word from a group is kept only when the product
 * data (names, descriptions, category names) contains ANY word of the SAME group, so "ملابس
 * حريمي" as a category justifies "women" or "نسائي". Every token is compared after the shared
 * search normaliser, so hamza / ta marbuta / alef maqsura spellings fold together. Fail-closed:
 * a correct gender word on a product whose data does not say it is dropped; the merchant can add
 * it as their own word. Brands (an open set) stay prompt-only.
 */
import { normalizeArabicSearch } from '@ebda/shared';

const GROUPS: Record<string, string[]> = {
  male: [
    'رجالي',
    'رجالى',
    'رجال',
    'رجالة',
    'شبابي',
    'شبابى',
    'ولادي',
    'ولادى',
    'men',
    'mens',
    'man',
    'male',
    'gents',
    'boys',
    'rgaly',
    'regaly',
    'regali',
    'rigali',
    'rigaly',
    'ragaly',
    'ragali',
    'rejaly',
    'shababy',
    'shababi',
  ],
  female: [
    'حريمي',
    'حريمى',
    'حريم',
    'نسائي',
    'نسائى',
    'نساء',
    'ستاتي',
    'ستاتى',
    'بناتي',
    'بناتى',
    'بنات',
    'سيدات',
    'سيده',
    'ستات',
    'women',
    'womens',
    'woman',
    'ladies',
    'lady',
    'female',
    'girls',
    'girl',
    '7arimy',
    '7arimi',
    '7aremy',
    '7erimy',
    '7arimi',
    'harimy',
    'harimi',
    'haremi',
    'haremy',
    'setaty',
    'sitati',
    'setati',
    'banaty',
    'banati',
    'nesa2y',
    'nisa2i',
  ],
  kids: [
    'اطفال',
    'أطفال',
    'طفل',
    'اطفالي',
    'بيبي',
    'بيبى',
    'مواليد',
    'ولادي',
    'kids',
    'kid',
    'baby',
    'babies',
    'children',
    'child',
    'toddler',
    'boys',
    'girls',
    'atfal',
    'atfaly',
    'aTfal',
    'beby',
    'bebe',
    'mawaleed',
    'wlady',
    'welady',
    'walady',
  ],
  summer: ['صيفي', 'صيفى', 'صيف', 'summer', 'sefy', 'seify', 'saify', 'sayfi', 'seifi', 'sefi'],
  winter: [
    'شتوي',
    'شتوى',
    'شتاء',
    'شتا',
    'شتوية',
    'winter',
    'shetwy',
    'shitwy',
    'shetawy',
    'shatawy',
    'shetwi',
  ],
};

const fold = (s: string) => normalizeArabicSearch(s);

/** Letters/digits runs after folding; "men's" → ["men", "s"], "7arimy" stays whole. */
const tokens = (s: string): string[] =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** folded token → the groups it belongs to ("girls" is both female and kids). */
const TOKEN_GROUPS = new Map<string, Set<string>>();
for (const [g, words] of Object.entries(GROUPS)) {
  for (const w of words) {
    const k = fold(w);
    if (!TOKEN_GROUPS.has(k)) TOKEN_GROUPS.set(k, new Set());
    TOKEN_GROUPS.get(k)!.add(g);
  }
}

/**
 * The groups one folded token belongs to. Arabic attaches the article and prepositions
 * (الأطفال, للأطفال, بالشتاء) and a feminine ending (رجالية → رجاليه after folding), so the bare
 * stem is tried too.
 */
function groupsOf(t: string): Set<string> | undefined {
  const direct = TOKEN_GROUPS.get(t);
  if (direct) return direct;
  const bare = t.replace(/^(?:وال|بال|لل|ال|ل)/, '');
  for (const c of [bare, bare.replace(/ه$/, ''), t.replace(/ه$/, '')]) {
    if (c && c.length >= 3 && TOKEN_GROUPS.has(c)) return TOKEN_GROUPS.get(c);
  }
  return undefined;
}

/** Which concept groups a text mentions. */
export function attributeGroups(text: string): Set<string> {
  const found = new Set<string>();
  for (const t of tokens(text)) for (const g of groupsOf(t) ?? []) found.add(g);
  return found;
}

/**
 * Returns a predicate: true when a generated term has an attribute word NONE of whose groups the
 * product data (`sourceText`) mentions. Per token, so an ambiguous word ("girls": female or kids)
 * is kept when either of its groups is stated.
 */
export function inventedAttributeFilter(sourceText: string): (term: string) => boolean {
  const stated = attributeGroups(sourceText);
  return term =>
    tokens(term).some(t => {
      const groups = groupsOf(t);
      return !!groups && ![...groups].some(g => stated.has(g));
    });
}
