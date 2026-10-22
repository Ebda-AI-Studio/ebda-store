/**
 * Smart Palette applied to a page DOCUMENT (Ruling VE-4: a draft edit, nothing live before Publish).
 *
 * The form page builder applied a palette to its layout state and staged the brand tokens for a
 * later `PUT /theme`. In the visual editor both halves land in the draft: the per-section colours
 * become `setSectionSetting`-equivalent writes on the matching sections, and the brand tokens join
 * the draft theme patch. One call = one document, so the editor can push it as ONE undo step.
 *
 * Only brand and derived colour tokens are taken from `themeUpdates` (the card toggles and page
 * colours the modal type also lists are staged by other page-builder cards, never by the palette).
 */
import { DERIVED_THEME_KEYS, DRAFT_THEME_KEYS, type DraftTheme } from './theme-draft';
import type { PageDefinition, SectionNode } from './schema';
import type { SectionKey, SectionPaletteEntry } from '../utils/color';

/** The palette's section keys, mapped to the registry section each one colours. */
const PALETTE_SECTION: Record<SectionKey, string> = {
  hero: 'hero',
  categories: 'category-grid',
  newArrivals: 'new-arrivals',
  bestSellers: 'best-sellers',
  testimonials: 'testimonials',
};

/** Sections whose cards get a frame in the palette (the page builder turns the frame on). */
const FRAMED = new Set<SectionKey>(['categories', 'newArrivals', 'bestSellers']);

const BRAND_KEYS = new Set<string>([...DRAFT_THEME_KEYS, ...DERIVED_THEME_KEYS]);
/** Keys the palette must never write even though they are editable theme settings. */
const NOT_PALETTE = new Set([
  'fontFamily',
  'headingFont',
  'bodyFont',
  'uppercaseStyle',
  'arabicNumerals',
  'borderRadius',
  'backgroundPreset',
  'bgPage',
  'bgSectionAlt',
  // product-card merchant switches (Ruling VE-17), never part of a palette
  'showBrandBadge',
  'showNewBadge',
  'showQuickAdd',
  'normalizeProductImages',
  'saleBadgeLegacyCorner',
]);

export function applySmartPalette(
  doc: PageDefinition,
  palette: Partial<
    Record<
      SectionKey,
      Pick<SectionPaletteEntry, 'bgColor' | 'cardFrameColor' | 'cardFrameWidth' | 'cardFrameSize'>
    >
  >,
  themeUpdates: Record<string, unknown>
): PageDefinition {
  const patchSection = (n: SectionNode, key: SectionKey): SectionNode => {
    const entry = palette[key];
    if (!entry) return n;
    const settings: Record<string, unknown> = { ...n.settings, bgColor: entry.bgColor };
    if (FRAMED.has(key)) {
      settings.showCardFrame = true;
      settings.cardFrameColor = entry.cardFrameColor;
      settings.cardFrameWidth = entry.cardFrameWidth;
      settings.cardFrameSize = entry.cardFrameSize;
    }
    return { ...n, settings };
  };
  const done = new Set<string>();
  const sections = doc.sections.map(n => {
    const key = (Object.keys(PALETTE_SECTION) as SectionKey[]).find(
      k => PALETTE_SECTION[k] === n.type && !done.has(n.type)
    );
    if (!key) return n;
    done.add(n.type); // the first section of a type, like the page builder's single fixed section
    return patchSection(n, key);
  });

  const theme: DraftTheme = { ...(doc.theme ?? {}) };
  for (const [k, v] of Object.entries(themeUpdates)) {
    if (!BRAND_KEYS.has(k) || NOT_PALETTE.has(k)) continue;
    if (typeof v === 'string') theme[k] = v;
  }
  return { ...doc, sections, ...(Object.keys(theme).length > 0 ? { theme } : {}) };
}
