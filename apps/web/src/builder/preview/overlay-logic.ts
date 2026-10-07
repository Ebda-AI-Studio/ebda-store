/**
 * DOM-free logic for the builder canvas overlay (unit-tested in node).
 */
import { getSectionDefinition, locateSection, type PageDefinition } from '@force/shared';

/** Minimal element shape the overlay needs (Element satisfies it). */
export interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export function sectionIdOf(el: ElementLike | null): string | null {
  return el?.closest('[data-builder-id]')?.getAttribute('data-builder-id') ?? null;
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
