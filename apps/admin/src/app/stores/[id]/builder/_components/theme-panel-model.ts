/**
 * The Theme panel's structure, as data (audit 2026-11-03, E-1). The panel is still generated from
 * `THEME_SETTINGS_SCHEMA`; this file only says WHERE each setting sits:
 *   tier 1  always visible: colour presets, three colours, the overall feel (spacing, corners, font)
 *   tier 2  accordion groups (one open at a time)
 *   tier 3  "Advanced" (closed, searchable): everything else, including the font library and zones
 * A setting the map does not name lands in Advanced, so a new schema entry is never lost.
 * Presets are data, not schema: a preset is a patch over `StoreTheme`, saved like any other edit
 * (Rulings THEME-DRAFT-1 and VE-4: only changed keys are written, nothing goes live before Publish).
 */
import { hexToHsl, hslToHex, type StoreTheme } from '@ebda/shared';

export const QUICK_COLOR_IDS = ['primaryColor', 'backgroundColor', 'foregroundColor'] as const;

export type Tier2Id = 'header' | 'cards' | 'images' | 'colors';
export const TIER2_ORDER: readonly Tier2Id[] = ['header', 'cards', 'images', 'colors'];

/** Setting id -> tier 2 group. Not listed (and not in tier 1) = Advanced. */
export const TIER2_OF: Record<string, Tier2Id> = {
  headerLogoPlacement: 'header',
  headerSearch: 'header',
  headerWordmark: 'header',
  tabBar: 'header',
  showBrandBadge: 'cards',
  showNewBadge: 'cards',
  showQuickAdd: 'cards',
  cardHeart: 'cards',
  cardSwatches: 'cards',
  cardTags: 'cards',
  heroRatio: 'images',
  secondaryColor: 'colors',
  accentColor: 'colors',
  mutedColor: 'colors',
  borderColor: 'colors',
  cardColor: 'colors',
  bgPage: 'colors',
  bgSectionAlt: 'colors',
  backgroundPreset: 'colors',
};

/** Tier 1 "feel" controls (segmented, at most four options each). */
export const FEEL_IDS = ['density', 'borderRadius', 'fontFamily'] as const;

export type Placement = 'quick-color' | 'feel' | Tier2Id | 'advanced';

export function placementOf(id: string): Placement {
  if ((QUICK_COLOR_IDS as readonly string[]).includes(id)) return 'quick-color';
  if ((FEEL_IDS as readonly string[]).includes(id)) return 'feel';
  return TIER2_OF[id] ?? 'advanced';
}

/** Corners: five stored radii read as three choices. The pick writes the middle value of its band. */
export const CORNER_BANDS = [
  { id: 'square', values: ['none'], write: 'none' },
  { id: 'soft', values: ['sm', 'md'], write: 'md' },
  { id: 'round', values: ['lg', 'xl'], write: 'xl' },
] as const;
export const cornerBandOf = (radius: unknown) =>
  CORNER_BANDS.find(b => (b.values as readonly unknown[]).includes(radius))?.id;

export interface ThemePreset {
  id: string;
  /** Egyptian-Arabic and English names; no orange anywhere (Ebda palette rule). */
  labelAr: string;
  labelEn: string;
  /** hex of the three swatch roles, for the card preview and the patch */
  primary: string;
  background: string;
  foreground: string;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'night-gold',
    labelAr: 'ليل وذهب',
    labelEn: 'Night and gold',
    primary: '#B08D57',
    background: '#14161B',
    foreground: '#F3EEE4',
  },
  {
    id: 'night-brass',
    labelAr: 'ليل ونحاس',
    labelEn: 'Night and brass',
    primary: '#A8744F',
    background: '#17130F',
    foreground: '#F1E6D8',
  },
  {
    id: 'moon-silver',
    labelAr: 'فضي قمري',
    labelEn: 'Moon silver',
    primary: '#8C97A6',
    background: '#101318',
    foreground: '#E8ECF1',
  },
  {
    id: 'ivory-ink',
    labelAr: 'عاجي وحبر',
    labelEn: 'Ivory and ink',
    primary: '#1F2A44',
    background: '#FAF7F0',
    foreground: '#1B1B1F',
  },
  {
    id: 'sage',
    labelAr: 'مريمية',
    labelEn: 'Sage',
    primary: '#5F7A61',
    background: '#F4F6F0',
    foreground: '#1E2A22',
  },
  {
    id: 'rose-clay',
    labelAr: 'وردي طيني',
    labelEn: 'Rose clay',
    primary: '#B5736B',
    background: '#FBF4F1',
    foreground: '#2B1E1D',
  },
];

/** The draft patch a preset stands for (theme colours are stored as HSL triplets). */
export function presetPatch(p: ThemePreset): Partial<StoreTheme> {
  return {
    primaryColor: hexToHsl(p.primary),
    backgroundColor: hexToHsl(p.background),
    foregroundColor: hexToHsl(p.foreground),
  };
}

/** True when the three colours of `theme` are the preset's (compared as hex, so HSL rounding is moot). */
export function presetIsActive(p: ThemePreset, theme: Record<string, unknown>): boolean {
  const hex = (k: string) => {
    const v = theme[k];
    return typeof v === 'string' && v.trim() ? hslToHex(v).toLowerCase() : '';
  };
  return (
    hex('primaryColor') === hslToHex(hexToHsl(p.primary)).toLowerCase() &&
    hex('backgroundColor') === hslToHex(hexToHsl(p.background)).toLowerCase() &&
    hex('foregroundColor') === hslToHex(hexToHsl(p.foreground)).toLowerCase()
  );
}

/** Does a setting match a search query (Arabic or English label, or the id)? */
export function matchesQuery(
  s: { id: string | number | symbol; labelAr: string; labelEn: string },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    s.labelAr.toLowerCase().includes(q) ||
    s.labelEn.toLowerCase().includes(q) ||
    String(s.id).toLowerCase().includes(q)
  );
}
