/**
 * DOM-free logic for the builder canvas overlay (unit-tested in node).
 */
import {
  AI_FILL_SECTIONS,
  getSectionDefinition,
  locateSection,
  nodeFor,
  textTargetsIn,
  type PageDefinition,
  type SectionOp,
  type TextTarget,
} from '@ebda/shared';

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

/**
 * The text setting an inline edit on `el` writes to, with the field's own
 * direction, or null (never guess: a wrong key would write the text somewhere
 * else). `target` is what the element belongs to (`targetOf`): a block's text
 * resolves against the block, a section's against the section.
 *   1. an explicit `data-builder-setting` marker, valid only if it names a
 *      text setting of that very node;
 *   2. otherwise the text setting whose CURRENT value equals the element's
 *      text exactly, and only when exactly one matches (skin-owned text).
 */
export function inlineTargetFor(
  el: ElementLike,
  doc: PageDefinition,
  target: CanvasTarget,
  locale: 'en' | 'ar'
): TextTarget | null {
  const targets = textTargetsIn(doc, target.sectionId, target.blockId);
  if (targets.length === 0) return null;
  const markedKey = el.closest('[data-builder-setting]')?.getAttribute('data-builder-setting');
  if (markedKey) return targets.find(t => t.key === markedKey) ?? null;
  const text = (el.textContent ?? '').trim();
  if (!text) return null;
  const settings = nodeFor(doc, target.sectionId, target.blockId)?.settings ?? {};
  const wantRtl = locale === 'ar';
  const matches = targets.filter(t => {
    const v = settings[t.key];
    // In the canvas locale only that locale's field is a candidate (title or titleAr, not both).
    const hasSibling = targets.some(o => o.key === `${t.key}Ar`);
    if (hasSibling && wantRtl) return false;
    if (t.dir === 'rtl' && !wantRtl) return false;
    return typeof v === 'string' && v.trim() === text;
  });
  return matches.length === 1 ? matches[0] : null;
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

/** A visible template section on the canvas: its place in the document list and its page box. */
export interface SlotBox {
  id: string;
  /** Index in `doc.sections` (hidden sections count, they just have no box). */
  index: number;
  top: number;
  bottom: number;
}

export interface Gap {
  /** The index a section inserted here gets (`addSection.index`). */
  index: number;
  /** Page y of the line. */
  y: number;
}

/**
 * Where a section can be inserted: before the first visible section, between
 * two neighbours (halfway across the space between them), and after the last.
 * An insertion between A and B goes right after A, so hidden sections that sit
 * between them stay behind it.
 */
export function insertionGaps(slots: readonly SlotBox[]): Gap[] {
  if (slots.length === 0) return [];
  const gaps: Gap[] = [{ index: slots[0].index, y: slots[0].top }];
  for (let i = 0; i < slots.length - 1; i++)
    gaps.push({ index: slots[i].index + 1, y: (slots[i].bottom + slots[i + 1].top) / 2 });
  const last = slots[slots.length - 1];
  gaps.push({ index: last.index + 1, y: last.bottom });
  return gaps;
}

export interface DropTarget {
  /** The final index of the dragged section in its list (what `move.toIndex` carries). */
  toIndex: number;
  /** Page y of the drop line. */
  y: number;
  /** True when dropping here changes nothing (the section's own place). */
  noop: boolean;
}

/** The gap closest to the pointer, as a drop for the section `draggedId`. Null if it is not on the canvas. */
export function dropTargetFor(
  slots: readonly SlotBox[],
  draggedId: string,
  pointerY: number
): DropTarget | null {
  const from = slots.find(s => s.id === draggedId);
  if (!from) return null;
  let best: Gap | null = null;
  for (const g of insertionGaps(slots))
    if (best === null || Math.abs(g.y - pointerY) < Math.abs(best.y - pointerY)) best = g;
  if (!best) return null;
  // Removing the section first shifts every later gap down by one.
  const toIndex = best.index > from.index ? best.index - 1 : best.index;
  return { toIndex, y: best.y, noop: toIndex === from.index };
}

export interface ToolbarState {
  /** The AI can write a kicker and subtitle for this section. */
  ai: boolean;
  /** Only a section drags on the canvas; a block moves with the arrows. */
  draggable: boolean;
  disabled: Partial<Record<SectionOp, boolean>>;
}

/**
 * Whether the selected target gets the canvas toolbar, and which buttons are
 * disabled (the parent still re-checks every op). Only template sections and
 * their blocks get one: the header, announcement bar and footer are chrome,
 * edited in the panes.
 */
export function toolbarStateFor(doc: PageDefinition, target: CanvasTarget): ToolbarState | null {
  const at = locateSection(doc, target.sectionId);
  if (!at || at.list !== 'template') return null;
  const def = getSectionDefinition(at.node.type);
  if (!def) return null;
  if (!target.blockId) {
    const sameType = doc.sections.filter(n => n.type === at.node.type).length;
    return {
      ai: at.node.type in AI_FILL_SECTIONS,
      draggable: true,
      disabled: {
        moveUp: at.index === 0,
        moveDown: at.index === doc.sections.length - 1,
        duplicate: sameType >= def.maxCount,
      },
    };
  }
  const blocks = at.node.blocks ?? [];
  const i = blocks.findIndex(b => b.id === target.blockId);
  if (i < 0) return null;
  const bd = def.blocks.find(b => b.type === blocks[i].type);
  return {
    ai: false,
    draggable: false,
    disabled: {
      moveUp: i === 0,
      moveDown: i === blocks.length - 1,
      duplicate: !bd || blocks.filter(b => b.type === bd.type).length >= bd.maxCount,
    },
  };
}
