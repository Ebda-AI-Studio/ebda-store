// packages/shared/src/utils/vibe-presets.ts
import type { ColorValue, PalettePattern } from './color';
import type { CardFrameWidth, CardFrameSize } from '../types/store-layout';

export type VibeId =
  | 'luxury'
  | 'boutique'
  | 'grocery'
  | 'streetwear'
  | 'minimal'
  | 'tech'
  | 'restaurant'
  | 'cafe'
  | 'beauty';

export interface VibePreset {
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  /** Recommended seeds. Merchants can override individually. */
  primary: ColorValue;
  accent: ColorValue;
  neutral: ColorValue;
  /** Vibe locks the pattern + frame defaults. */
  pattern: PalettePattern;
  cardFrameWidth: CardFrameWidth;
  cardFrameSize: CardFrameSize;
}

/**
 * Heuristic vibe presets for the Smart Palette vibe picker (Layer B).
 * When a merchant selects a vibe, seeds + pattern + frame settings are
 * overridden with the matching preset. Merchant can still tweak individual
 * seeds after picking (manual edits always win — Layer D).
 */
export const VIBE_PRESETS: Record<VibeId, VibePreset> = {
  luxury: {
    label: 'Luxury',
    labelAr: 'فاخر',
    description: 'Restrained, premium, gallery-grade',
    descriptionAr: 'متحفظ، فاخر، بمستوى المعارض',
    primary: '#1F2937',
    accent: '#A78248',
    neutral: '#F5F3F0',
    pattern: 'alternating',
    cardFrameWidth: 'thin',
    cardFrameSize: 'spacious',
  },
  boutique: {
    label: 'Boutique',
    labelAr: 'بوتيك',
    description: 'Editorial, soft, fashion-forward',
    descriptionAr: 'تحريري، ناعم، عصري',
    primary: '#7C2D12',
    accent: '#D4A574',
    neutral: '#FAF7F2',
    pattern: 'alternating',
    cardFrameWidth: 'thin',
    cardFrameSize: 'comfortable',
  },
  grocery: {
    label: 'Grocery',
    labelAr: 'بقالة',
    description: 'Bright, dense, trustworthy',
    descriptionAr: 'مشرق، كثيف، موثوق',
    primary: '#16A34A',
    accent: '#EAB308',
    neutral: '#FFFFFF',
    pattern: 'single-bg',
    cardFrameWidth: 'thin',
    cardFrameSize: 'compact',
  },
  streetwear: {
    label: 'Streetwear',
    labelAr: 'ملابس الشارع',
    description: 'High-contrast, bold, energetic',
    descriptionAr: 'عالي التباين، جريء، نشط',
    primary: '#0A0A0A',
    accent: '#FBBF24',
    neutral: '#FFFFFF',
    pattern: 'monochrome',
    cardFrameWidth: 'thick',
    cardFrameSize: 'compact',
  },
  minimal: {
    label: 'Minimal',
    labelAr: 'بسيط',
    description: 'Quiet, neutral, content-first',
    descriptionAr: 'هادئ، محايد، يركز على المحتوى',
    primary: '#0A0A0A',
    accent: '#737373',
    neutral: '#FFFFFF',
    pattern: 'single-bg',
    cardFrameWidth: 'thin',
    cardFrameSize: 'spacious',
  },
  tech: {
    label: 'Tech',
    labelAr: 'تقني',
    description: 'Cool, modern, electric',
    descriptionAr: 'بارد، حديث، كهربائي',
    primary: '#2563EB',
    accent: '#06B6D4',
    neutral: '#F8FAFC',
    pattern: 'alternating',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
  },
  restaurant: {
    label: 'Restaurant',
    labelAr: 'مطعم',
    description: 'Warm, appetizing, hospitable',
    descriptionAr: 'دافئ، فاتح للشهية، مضياف',
    primary: '#9A3412',
    accent: '#CA8A04',
    neutral: '#FFFBEB',
    pattern: 'triad',
    cardFrameWidth: 'thin',
    cardFrameSize: 'comfortable',
  },
  cafe: {
    label: 'Cafe',
    labelAr: 'مقهى',
    description: 'Cozy, artisanal, inviting',
    descriptionAr: 'مريح، حرفي، جذاب',
    primary: '#6B4423',
    accent: '#D6A35C',
    neutral: '#FAF4EB',
    pattern: 'alternating',
    cardFrameWidth: 'thin',
    cardFrameSize: 'comfortable',
  },
  beauty: {
    label: 'Beauty',
    labelAr: 'تجميل',
    description: 'Soft, blush, feminine',
    descriptionAr: 'ناعم، وردي، أنثوي',
    primary: '#BE185D',
    accent: '#F472B6',
    neutral: '#FDF2F8',
    pattern: 'alternating',
    cardFrameWidth: 'thin',
    cardFrameSize: 'comfortable',
  },
};

/**
 * Look up a vibe preset by ID.
 * Returns undefined when vibeId is missing — caller keeps current state.
 */
export function getVibePreset(vibeId: VibeId | undefined): VibePreset | undefined {
  if (!vibeId) return undefined;
  return VIBE_PRESETS[vibeId];
}
