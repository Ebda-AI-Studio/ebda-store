/**
 * Arabic display fallbacks for product-option axis NAMES and UNIT tokens inside
 * option VALUES.
 *
 * Why: variant options imported from OSOSS (and many manual entries) store only
 * English (`Size`, `185 Gram`) with `nameAr`/`valueAr` left blank. On the Arabic
 * storefront that surfaced raw English ("Size:", "185 Gram"). These helpers
 * translate the common cases at DISPLAY time so the Arabic store reads Arabic
 * platform-wide, WITHOUT mutating the stored data.
 *
 * Precedence: a merchant-supplied `nameAr`/`valueAr` ALWAYS wins; the maps below
 * are only the fallback when that translation is empty and the locale is Arabic.
 *
 * Note on "Size": this is a FOOD/grocery platform, so Size means volume/weight
 * → الحجم (NOT المقاس, which reads as a clothing fit).
 */

const OPTION_NAME_AR: Record<string, string> = {
  size: 'الحجم',
  weight: 'الوزن',
  volume: 'الحجم',
  quantity: 'الكمية',
  flavor: 'النكهة',
  flavour: 'النكهة',
  taste: 'النكهة',
  color: 'اللون',
  colour: 'اللون',
  type: 'النوع',
  kind: 'النوع',
  variant: 'الخيار',
  option: 'الخيار',
  pack: 'العبوة',
  packaging: 'التغليف',
  style: 'الشكل',
  grind: 'الطحن',
  roast: 'التحميص',
};

/**
 * Unit / common-word tokens → Arabic, matched case-insensitively on word
 * boundaries. Longer tokens are listed BEFORE their abbreviations so
 * "kilogram" wins over "kg" wins over a bare unit. Numbers are preserved.
 */
const VALUE_TOKEN_AR: Array<[RegExp, string]> = [
  [/\bkilograms?\b/gi, 'كيلوجرام'],
  [/\bkgs?\b/gi, 'كجم'],
  [/\bgrams?\b/gi, 'جرام'],
  [/\bgms?\b/gi, 'جرام'],
  [/\bmilligrams?\b/gi, 'مجم'],
  [/\bmilliliters?\b/gi, 'مل'],
  [/\bmls?\b/gi, 'مل'],
  [/\bliters?\b/gi, 'لتر'],
  [/\blitres?\b/gi, 'لتر'],
  [/\bpieces?\b/gi, 'قطعة'],
  [/\bpcs?\b/gi, 'قطعة'],
  [/\bdozen\b/gi, 'دزينة'],
  [/\bpack\b/gi, 'عبوة'],
  [/\bbox\b/gi, 'علبة'],
  [/\bbottles?\b/gi, 'زجاجة'],
  [/\bcans?\b/gi, 'علبة'],
  [/\bbags?\b/gi, 'كيس'],
  [/\bx-?large\b/gi, 'كبير جداً'],
  [/\bsmall\b/gi, 'صغير'],
  [/\bmedium\b/gi, 'وسط'],
  [/\blarge\b/gi, 'كبير'],
];

/** Garment letter-size tokens (S / M / L / XL / XXL / 2XL …). These are
 *  unambiguously clothing sizes (a weight/volume is never "XL"), so when a
 *  "Size" option's values look like these we translate the axis as مقاس
 *  (garment fit) rather than حجم (volume/weight, the food default). */
const GARMENT_SIZE_RE = /^(xs|s|m|l|xl|xxl|xxxl|[2-5]xl)$/i;

function looksLikeGarmentSizes(values?: string[]): boolean {
  if (!values || values.length === 0) return false;
  return values.some(v => GARMENT_SIZE_RE.test(v.trim()));
}

/** Localise an option axis label ("Size" → "الحجم"). Merchant Arabic wins; else
 *  the option-name map; else English. For the ambiguous "Size" axis it is
 *  context-aware: garment letter-sizes in `values` → مقاس (clothing fit),
 *  otherwise الحجم (food/grocery volume-weight default). */
export function localizeOptionName(
  name: string,
  nameAr: string | null | undefined,
  isRtl: boolean,
  values?: string[]
): string {
  if (!isRtl) return name;
  if (nameAr && nameAr.trim()) return nameAr;
  const key = name.trim().toLowerCase();
  if (key === 'size' && looksLikeGarmentSizes(values)) return 'مقاس';
  return OPTION_NAME_AR[key] ?? name;
}

/** Localise an option value ("185 Gram" → "185 جرام"). Translates every known
 *  unit token in place, preserving numbers + separators. Merchant `valueAr`
 *  wins; English is returned untouched when not RTL. */
export function localizeOptionValue(
  value: string,
  valueAr: string | null | undefined,
  isRtl: boolean
): string {
  if (!isRtl) return value;
  if (valueAr && valueAr.trim()) return valueAr;
  let out = value;
  for (const [re, ar] of VALUE_TOKEN_AR) out = out.replace(re, ar);
  return out;
}
