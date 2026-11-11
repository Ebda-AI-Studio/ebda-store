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
 * Precedence: a MEANINGFUL merchant-supplied `nameAr`/`valueAr` wins, then (in
 * Arabic) the merchant's meaningful English name translated through the map —
 * the same name the English storefront shows (#2193); generic placeholder axis
 * names (notably the old admin default "متغير") are ignored so smart
 * value-driven detection runs.
 *
 * Axis labelling is value-aware (see `localizeOptionName`): weight-unit values →
 * الوزن, volume-unit values → الحجم, garment letter-sizes → المقاس. We never
 * surface the placeholder "متغير".
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
 *  unambiguously clothing sizes (a weight/volume is never "XL"), so when an
 *  option's values look like these we translate the axis as المقاس (clothing
 *  fit) rather than الحجم (volume) or الوزن (weight). */
// QA-C5: also «مقاس 6» / "Size 6" (a ring or shoe size written out): the axis is المقاس, never a guess.
const GARMENT_SIZE_RE = /^(xs|s|m|l|xl|xxl|xxxl|[2-5]xl|(?:مقاس|size)\s*\S+)$/i;

/** A value carries a WEIGHT unit (185 Gram, 1 KG, 500g, ٧٠٠ جرام). The Latin
 *  branch uses `\b`; the Arabic branch omits it (`\b` is unreliable on Arabic
 *  script). A leading digit is required so a stray "g"/"l" doesn't false-match. */
const WEIGHT_VALUE_RE =
  /[0-9٠-٩۰-۹]\s*(?:kilograms?|kgs?|milligrams?|grams?|gms?|mg|g)\b|[0-9٠-٩۰-۹]\s*(?:كيلوجرام|كيلوغرام|كيلو|كجم|جرامات|جرام|غرام|جم|مجم)/i;

/** A value carries a VOLUME unit (500 ml, 1 Liter, ٢ لتر). */
const VOLUME_VALUE_RE =
  /[0-9٠-٩۰-۹]\s*(?:milliliters?|mls?|liters?|litres?|l)\b|[0-9٠-٩۰-۹]\s*(?:مليلتر|لتر|مل)/i;

/** Arabic/English axis names that are GENERIC placeholders (no real meaning) —
 *  treated as if `nameAr` were blank so the smart value-driven detection runs.
 *  Notably includes "متغير" (the old admin default) which we must never show. */
const GENERIC_AXIS_NAMES = new Set([
  'متغير',
  'الخيار',
  'خيار',
  'الخيارات',
  'variant',
  'variants',
  'option',
  'options',
]);

function anyValueMatches(values: string[] | undefined, re: RegExp): boolean {
  if (!values || values.length === 0) return false;
  return values.some(v => re.test(v.trim()));
}

function looksLikeGarmentSizes(values?: string[]): boolean {
  if (!values || values.length === 0) return false;
  return values.some(v => GARMENT_SIZE_RE.test(v.trim()));
}

/** The axis type inferred from the option VALUES (units are unambiguous). */
function detectAxisFromValues(values?: string[]): 'weight' | 'volume' | 'garment' | null {
  if (anyValueMatches(values, WEIGHT_VALUE_RE)) return 'weight';
  if (anyValueMatches(values, VOLUME_VALUE_RE)) return 'volume';
  if (looksLikeGarmentSizes(values)) return 'garment';
  return null;
}

/** Locale-appropriate label per detected axis type. */
const AXIS_LABEL: Record<'weight' | 'volume' | 'garment', { en: string; ar: string }> = {
  weight: { en: 'Weight', ar: 'الوزن' },
  volume: { en: 'Size', ar: 'الحجم' },
  garment: { en: 'Size', ar: 'المقاس' },
};

/** Localise an option axis label for BOTH storefront locales. Precedence
 *  (fixed 2026-09-25, issue #657 — "merchant name wins"; value detection
 *  used to run FIRST and silently overrode a merchant's own meaningful axis
 *  name, e.g. nameAr='التعبئة' with values '500 جرام' rendered as 'الوزن'):
 *  1. a MEANINGFUL merchant name for the active locale — generic placeholders
 *     ("Variant", "Option", the old "متغير" default) and a blank name do NOT
 *     win, so they fall through;
 *  1b. (Arabic only) a MEANINGFUL English name with an entry in the option-name
 *     map — so both locales name the SAME axis concept (#2193): `Size` reads
 *     "Size" / "الحجم", never "Size" / "الوزن";
 *  2. VALUE-driven detection (units are unambiguous) — a generic/blank axis
 *     (or, in Arabic, an English name the map cannot translate) whose values
 *     are "400 Gram / 700 Gram" reads Weight / الوزن;
 *  3. a neutral fallback ("Options" / الخيار). The label is NEVER "متغير" or a
 *     bare "Variant". */
export function localizeOptionName(
  name: string,
  nameAr: string | null | undefined,
  isRtl: boolean,
  values?: string[]
): string {
  if (isRtl) {
    const trimmedAr = nameAr?.trim();
    if (trimmedAr && !GENERIC_AXIS_NAMES.has(trimmedAr.toLowerCase())) return trimmedAr;

    // The merchant's MEANINGFUL English name, translated through the map,
    // outranks value detection too (#2193) — exactly as it does on the
    // English storefront below. Otherwise `name='Size'` + `185 Gram` read
    // "Size" in EN but "الوزن" (Weight) in AR: two different axis concepts
    // for the same option. Generic names ("Variant", "Option") are skipped so
    // they still fall through to detection.
    const trimmedEn = name?.trim().toLowerCase();
    if (trimmedEn && !GENERIC_AXIS_NAMES.has(trimmedEn) && OPTION_NAME_AR[trimmedEn]) {
      return OPTION_NAME_AR[trimmedEn];
    }

    const axis = detectAxisFromValues(values);
    if (axis) return AXIS_LABEL[axis].ar;

    return 'الخيار';
  }

  const trimmedEn = name?.trim();
  if (trimmedEn && !GENERIC_AXIS_NAMES.has(trimmedEn.toLowerCase())) return trimmedEn;

  const axis = detectAxisFromValues(values);
  if (axis) return AXIS_LABEL[axis].en;

  return 'Options';
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
