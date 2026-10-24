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
 * defaults"). Empty since the five Force skins were deleted (Ruling SKIN-DEL-1): every seed
 * belonged to one of them, and the Ebda templates take their palette from their looks.
 */
export const TEMPLATE_PRESETS: Record<string, TemplateSeeds> = {};

/**
 * Look up the Smart Palette seed defaults for a template.
 * Returns undefined when templateId is missing or not in the map —
 * caller falls back to the modal's own defaults.
 */
export function getTemplatePresets(templateId: string | undefined): TemplateSeeds | undefined {
  if (!templateId) return undefined;
  return TEMPLATE_PRESETS[templateId];
}
