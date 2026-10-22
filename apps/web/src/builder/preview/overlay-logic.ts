/**
 * DOM-free logic for the builder canvas overlay (unit-tested in node).
 */
import { getSectionDefinition, locateSection, type PageDefinition } from '@ebda/shared';

/** Minimal element shape the overlay needs (Element satisfies it). */
export interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export function sectionIdOf(el: ElementLike | null): string | null {
  return el?.closest('[data-builder-id]')?.getAttribute('data-builder-id') ?? null;
}

export interface CanvasTarget {
  sectionId: string;
  blockId?: string;
}

/** Storefront chrome zones, mapped to the document section type they stand for. */
const CHROME_ZONES = [
  ['header', 'header', 'header'],
  ['beforeHeader', 'header', 'announcement'],
  ['footer', 'footer', 'footer'],
] as const;

/**
 * What a click or hover on `el` selects: a block when the element sits inside
 * a marked block (`data-builder-block`), else the marked section, else the
 * header / announcement bar / footer chrome (found by its storefront
 * `data-zone` wrapper and resolved to the document's section of that type, so
 * the public markup needs no editor attribute). Null when nothing editable.
 */
export function targetOf(el: ElementLike | null, doc?: PageDefinition): CanvasTarget | null {
  if (!el) return null;
  const section = el.closest('[data-builder-id]');
  const sectionId = section?.getAttribute('data-builder-id') ?? null;
  if (sectionId) {
    const blockEl = el.closest('[data-builder-block]');
    const blockId = blockEl?.getAttribute('data-builder-block') ?? null;
    // A block marker only counts inside the section that owns it.
    const owner = blockEl?.closest('[data-builder-id]')?.getAttribute('data-builder-id');
    return blockId && owner === sectionId ? { sectionId, blockId } : { sectionId };
  }
  if (!doc) return null;
  for (const [zone, group, type] of CHROME_ZONES) {
    if (!el.closest(`[data-zone="${zone}"]`)) continue;
    const node = doc.sectionGroups[group].find(n => n.type === type);
    return node ? { sectionId: node.id } : null;
  }
  return null;
}

/** The document-section type of a node plus its label in `locale`. */
export function labelFor(
  doc: PageDefinition,
  target: CanvasTarget,
  locale: 'en' | 'ar'
): string | null {
  const node = locateSection(doc, target.sectionId)?.node;
  const def = node ? getSectionDefinition(node.type) : undefined;
  if (!node || !def) return null;
  const sectionLabel = locale === 'ar' ? def.labelAr : def.labelEn;
  if (!target.blockId) return sectionLabel;
  const block = node.blocks?.find(b => b.id === target.blockId);
  if (!block) return sectionLabel;
  const bd = def.blocks.find(b => b.type === block.type);
  if (!bd) return sectionLabel;
  const same = (node.blocks ?? []).filter(b => b.type === block.type);
  const n = same.findIndex(b => b.id === block.id) + 1;
  return `${locale === 'ar' ? bd.labelAr : bd.labelEn} ${n}`;
}

/**
 * The setting an inline edit on `el` writes to, or null when the text is not
 * a plain merchant text setting (never guess: a wrong key would write the
 * text somewhere else).
 *   1. an explicit `data-builder-setting` marker (document-only sections);
 *   2. otherwise a `text`/`textarea` setting of the section whose CURRENT
 *      value (in the canvas locale) equals the element's text exactly, and
 *      only when exactly one setting matches.
 */
export function inlineSettingFor(
  el: ElementLike,
  doc: PageDefinition,
  sectionId: string,
  locale: 'en' | 'ar'
): string | null {
  const marked = el.closest('[data-builder-setting]');
  const markedKey = marked?.getAttribute('data-builder-setting');
  const section = locateSection(doc, sectionId)?.node;
  if (!section) return null;
  const d = getSectionDefinition(section.type);
  if (!d) return null;
  const textIds = d.settings
    .filter(s => s.type === 'text' || s.type === 'textarea')
    .flatMap(s => (s.localized ? [s.id, `${s.id}Ar`] : [s.id]));
  if (markedKey) return textIds.includes(markedKey) ? markedKey : null;
  const text = (el.textContent ?? '').trim();
  if (!text) return null;
  const candidates = d.settings
    .filter(s => s.type === 'text' || s.type === 'textarea')
    .map(s => (s.localized && locale === 'ar' ? `${s.id}Ar` : s.id))
    .filter(
      key =>
        typeof section.settings[key] === 'string' &&
        (section.settings[key] as string).trim() === text
    );
  return candidates.length === 1 ? candidates[0] : null;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Union of child boxes (a `display: contents` wrapper has no box of its own). */
export function unionRect(rects: Rect[]): Rect | null {
  const real = rects.filter(r => r.width > 0 || r.height > 0);
  if (real.length === 0) return null;
  const top = Math.min(...real.map(r => r.top));
  const left = Math.min(...real.map(r => r.left));
  const bottom = Math.max(...real.map(r => r.top + r.height));
  const right = Math.max(...real.map(r => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}
