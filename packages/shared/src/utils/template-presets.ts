// packages/shared/src/utils/template-presets.ts
import type { ColorValue, PalettePattern } from './color';
import type { CardFrameWidth, CardFrameSize } from '../types/store-layout';

export interface TemplateSeeds {
  primary: ColorValue;
  accent: ColorValue;
  neutral: ColorValue;
  pattern: PalettePattern;
  cardFrameWidth: CardFrameWidth;
  cardFrameSize: CardFrameSize;
}

/**
 * Per-template recommended Smart Palette seeds. Pre-fills modal inputs
 * when merchant opens it for the first time (or clicks "Reset to template
 * defaults"). Aesthetic matches the template's identity per the FWB
 * theme-identity audit (2026-05-20).
 */
export const TEMPLATE_PRESETS: Record<string, TemplateSeeds> = {
  modern: {
    primary: '#2563EB', // clean blue
    accent: '#0EA5E9', // sky accent
    neutral: '#F8FAFC', // near-white surface
    pattern: 'alternating',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
  },
  elegant: {
    primary: '#7C2D12', // muted boutique burgundy
    accent: '#A16207', // antique gold
    neutral: '#FAF9F6', // cream
    pattern: 'alternating',
    cardFrameWidth: 'thin',
    cardFrameSize: 'comfortable',
  },
  classic: {
    primary: '#7F1D1D', // heritage burgundy
    accent: '#1E3A8A', // deep navy
    neutral: '#FEF3C7', // cream-yellow
    pattern: 'triad',
    cardFrameWidth: 'thin',
    cardFrameSize: 'normal',
  },
  minimal: {
    primary: '#0A0A0A', // near-black
    accent: '#737373', // mid gray
    neutral: '#FFFFFF', // pure white
    pattern: 'single-bg',
    cardFrameWidth: 'thin',
    cardFrameSize: 'spacious',
  },
  bold: {
    primary: '#DC2626', // high-contrast red
    accent: '#FBBF24', // gold pop
    neutral: '#FAFAFA', // off-white
    pattern: 'monochrome',
    cardFrameWidth: 'thick',
    cardFrameSize: 'compact',
  },
};

/**
 * Look up the Smart Palette seed defaults for a template.
 * Returns undefined when templateId is missing or not in the map —
 * caller falls back to the modal's own defaults.
 */
export function getTemplatePresets(templateId: string | undefined): TemplateSeeds | undefined {
  if (!templateId) return undefined;
  return TEMPLATE_PRESETS[templateId];
}
