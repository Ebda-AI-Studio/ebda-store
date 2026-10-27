/**
 * `areaKey` (Customer Intelligence 1.3): `EG-<governorate code>-<district slug>` (e.g. `EG-C-nasr-city`),
 * or the governorate only (`EG-C`) when no district alias matches. NEVER the street, building, floor,
 * landmark or postal code: those fields are not even read here.
 *
 * Governorate resolution reuses the carrier adapters' folded-name index (services/carriers/egypt-areas),
 * so "القاهرة", "Cairo" and "Al Qahirah" are one key. District aliases are a small pinned table of the
 * districts that matter for courier performance; a miss is counted by the caller, never guessed.
 */
import {
  canonicalGovernorate,
  normalizeName,
  type EgyptGovernorate,
} from '../../services/carriers/egypt-areas';

/** ISO 3166-2:EG codes by the governorate key used in services/carriers/egypt-areas. */
export const GOVERNORATE_CODE: Readonly<Record<string, string>> = {
  cairo: 'C',
  giza: 'GZ',
  alexandria: 'ALX',
  qalyubia: 'KB',
  sharqia: 'SHR',
  dakahlia: 'DK',
  gharbia: 'GH',
  monufia: 'MNF',
  beheira: 'BH',
  'kafr-el-sheikh': 'KFS',
  damietta: 'DT',
  'port-said': 'PTS',
  ismailia: 'IS',
  suez: 'SUZ',
  'north-sinai': 'SIN',
  'south-sinai': 'JS',
  'red-sea': 'BA',
  fayoum: 'FYM',
  'beni-suef': 'BNS',
  minya: 'MN',
  assiut: 'AST',
  sohag: 'SHG',
  qena: 'KN',
  luxor: 'LX',
  aswan: 'ASN',
  'new-valley': 'WAD',
  matrouh: 'MT',
};

interface District {
  slug: string;
  governorate: string;
  aliases: readonly string[];
}

/** Pinned district aliases (Arabic and English spellings). Extend by PR; a miss stays at governorate level. */
export const DISTRICTS: readonly District[] = [
  { slug: 'nasr-city', governorate: 'cairo', aliases: ['Nasr City', 'Madinet Nasr', 'مدينة نصر'] },
  { slug: 'maadi', governorate: 'cairo', aliases: ['Maadi', 'El Maadi', 'المعادي'] },
  {
    slug: 'heliopolis',
    governorate: 'cairo',
    aliases: ['Heliopolis', 'Masr El Gedida', 'مصر الجديدة'],
  },
  {
    slug: 'new-cairo',
    governorate: 'cairo',
    aliases: ['New Cairo', 'Tagamoa', 'Fifth Settlement', 'القاهرة الجديدة', 'التجمع الخامس'],
  },
  { slug: 'shorouk', governorate: 'cairo', aliases: ['Shorouk', 'El Shorouk', 'الشروق'] },
  { slug: 'obour', governorate: 'cairo', aliases: ['Obour', 'El Obour', 'العبور'] },
  { slug: 'rehab', governorate: 'cairo', aliases: ['Rehab', 'Al Rehab', 'الرحاب'] },
  { slug: 'madinaty', governorate: 'cairo', aliases: ['Madinaty', 'مدينتي'] },
  { slug: 'zamalek', governorate: 'cairo', aliases: ['Zamalek', 'الزمالك'] },
  { slug: 'downtown', governorate: 'cairo', aliases: ['Downtown', 'Wust El Balad', 'وسط البلد'] },
  { slug: 'shubra', governorate: 'cairo', aliases: ['Shubra', 'Shoubra', 'شبرا'] },
  { slug: 'mokattam', governorate: 'cairo', aliases: ['Mokattam', 'المقطم'] },
  {
    slug: 'mohandessin',
    governorate: 'giza',
    aliases: ['Mohandessin', 'Mohandiseen', 'المهندسين'],
  },
  { slug: 'dokki', governorate: 'giza', aliases: ['Dokki', 'Dokki Giza', 'الدقي'] },
  { slug: 'haram', governorate: 'giza', aliases: ['Haram', 'Al Haram', 'الهرم'] },
  { slug: 'faisal', governorate: 'giza', aliases: ['Faisal', 'فيصل'] },
  {
    slug: '6th-october',
    governorate: 'giza',
    aliases: [
      '6th of October',
      '6 October',
      'Sixth of October',
      'October City',
      'السادس من اكتوبر',
      '6 اكتوبر',
      'مدينة 6 اكتوبر',
    ],
  },
  {
    slug: 'sheikh-zayed',
    governorate: 'giza',
    aliases: ['Sheikh Zayed', 'El Sheikh Zayed', 'الشيخ زايد'],
  },
  { slug: 'smouha', governorate: 'alexandria', aliases: ['Smouha', 'سموحة'] },
  { slug: 'miami', governorate: 'alexandria', aliases: ['Miami', 'ميامي'] },
  { slug: 'montaza', governorate: 'alexandria', aliases: ['Montaza', 'المنتزه'] },
  { slug: 'sidi-gaber', governorate: 'alexandria', aliases: ['Sidi Gaber', 'سيدي جابر'] },
];

const DISTRICT_INDEX: Map<string, District> = (() => {
  const m = new Map<string, District>();
  for (const d of DISTRICTS) for (const a of d.aliases) m.set(normalizeName(a), d);
  return m;
})();

export interface AreaKeyInput {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  area?: string | null;
}

export interface AreaKeyResult {
  /** null when the destination is not an Egyptian governorate we can name. */
  areaKey: string | null;
  /** `none` is the miss the caller counts (the alias table or the address needs attention). */
  level: 'district' | 'governorate' | 'none';
}

function districtOf(...names: Array<string | null | undefined>): District | null {
  for (const n of names) {
    if (!n) continue;
    const hit = DISTRICT_INDEX.get(normalizeName(n));
    if (hit) return hit;
  }
  return null;
}

export function areaKeyFor(input: AreaKeyInput): AreaKeyResult {
  const country = (input.country ?? 'EG').trim().toUpperCase();
  if (country && country !== 'EG' && country !== 'EGY' && country !== 'EGYPT') {
    return { areaKey: null, level: 'none' };
  }
  const district = districtOf(input.area, input.city);
  const gov: EgyptGovernorate | null =
    canonicalGovernorate(input.state) ??
    canonicalGovernorate(input.city) ??
    canonicalGovernorate(input.area) ??
    (district ? (canonicalGovernorate(district.governorate) ?? null) : null);
  const code = gov ? GOVERNORATE_CODE[gov.key] : undefined;
  if (!gov || !code) return { areaKey: null, level: 'none' };
  // A district belongs to ONE governorate: a "Maadi" typed under Alexandria is not Cairo's Maadi.
  if (district && district.governorate === gov.key) {
    return { areaKey: `EG-${code}-${district.slug}`, level: 'district' };
  }
  return { areaKey: `EG-${code}`, level: 'governorate' };
}
