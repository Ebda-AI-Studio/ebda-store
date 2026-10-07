/**
 * Pure editing operations on a `PageDefinition` (visual builder Phase 2).
 * The admin editor dispatches these; undo/redo wraps them (`history.ts`).
 *
 * Every action returns a NEW document (structural sharing, never mutation)
 * and refuses edits that would break a registry invariant — cardinality,
 * block types, section-group placement — by returning the input unchanged
 * with `rejected` set, so the UI can explain instead of producing a
 * document the API will 422.
 */
import { sectionFromPreset } from '../adapter';
import { getSectionDefinition } from '../registry';
import type { BlockNode, PageDefinition, SectionGroupKey, SectionNode } from '../schema';
import type { Viewport } from '../viewports';

/** Where a section lives: one of the two groups, or the template. */
export type SectionList = SectionGroupKey | 'template';

export type DocumentAction =
  | {
      type: 'addSection';
      list: SectionList;
      sectionType: string;
      presetIndex: number;
      index?: number;
    }
  | { type: 'removeSection'; id: string }
  | { type: 'duplicateSection'; id: string }
  | { type: 'moveSection'; id: string; toIndex: number }
  | { type: 'setSectionHidden'; id: string; hidden: boolean }
  | { type: 'setSectionSetting'; id: string; key: string; value: unknown }
  | { type: 'setViewportHidden'; id: string; viewport: Viewport; hidden: boolean | undefined }
  | { type: 'setViewportSetting'; id: string; viewport: Viewport; key: string; value: unknown }
  | { type: 'addBlock'; sectionId: string; blockType: string }
  | { type: 'removeBlock'; sectionId: string; blockId: string }
  | { type: 'duplicateBlock'; sectionId: string; blockId: string }
  | { type: 'moveBlock'; sectionId: string; blockId: string; toIndex: number }
  | { type: 'setBlockHidden'; sectionId: string; blockId: string; hidden: boolean }
  | { type: 'setBlockSetting'; sectionId: string; blockId: string; key: string; value: unknown };

export interface ReduceResult {
  doc: PageDefinition;
  /** Set when the action was refused; `doc` is then the input, unchanged. */
  rejected?:
    | 'CARDINALITY'
    | 'NOT_FOUND'
    | 'BLOCK_NOT_SUPPORTED'
    | 'GROUP_MISMATCH'
    | 'UNKNOWN_TYPE';
  /** Id of the section/block the action created, for selection. */
  createdId?: string;
}

function lists(doc: PageDefinition): Record<SectionList, SectionNode[]> {
  return {
    header: doc.sectionGroups.header,
    template: doc.sections,
    footer: doc.sectionGroups.footer,
  };
}

function withList(doc: PageDefinition, list: SectionList, nodes: SectionNode[]): PageDefinition {
  if (list === 'template') return { ...doc, sections: nodes };
  return { ...doc, sectionGroups: { ...doc.sectionGroups, [list]: nodes } };
}

export function locateSection(
  doc: PageDefinition,
  id: string
): { list: SectionList; index: number; node: SectionNode } | null {
  for (const [list, nodes] of Object.entries(lists(doc)) as Array<[SectionList, SectionNode[]]>) {
    const index = nodes.findIndex(n => n.id === id);
    if (index >= 0) return { list, index, node: nodes[index] };
  }
  return null;
}

function allIds(doc: PageDefinition): Set<string> {
  const ids = new Set<string>();
  for (const nodes of Object.values(lists(doc)))
    for (const n of nodes) {
      ids.add(n.id);
      for (const b of n.blocks ?? []) ids.add(`${n.id}/${b.id}`);
    }
  return ids;
}

/** A fresh id `<base>-<n>` not used in the document. */
export function uniqueSectionId(doc: PageDefinition, base: string): string {
  const ids = allIds(doc);
  const stem =
    base
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'section';
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`;
    if (!ids.has(id)) return id;
  }
}

function uniqueBlockId(section: SectionNode, base: string): string {
  const ids = new Set((section.blocks ?? []).map(b => b.id));
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!ids.has(id)) return id;
  }
}

function countType(doc: PageDefinition, type: string): number {
  return Object.values(lists(doc)).reduce(
    (n, nodes) => n + nodes.filter(s => s.type === type).length,
    0
  );
}

function updateSection(
  doc: PageDefinition,
  id: string,
  fn: (n: SectionNode) => SectionNode
): ReduceResult {
  const at = locateSection(doc, id);
  if (!at) return { doc, rejected: 'NOT_FOUND' };
  const nodes = [...lists(doc)[at.list]];
  nodes[at.index] = fn(at.node);
  return { doc: withList(doc, at.list, nodes) };
}

function move<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  const clamped = Math.max(0, Math.min(out.length - 1, to));
  const [x] = out.splice(from, 1);
  out.splice(clamped, 0, x);
  return out;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setKey(
  obj: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const out = { ...obj };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

function updateBlock(
  doc: PageDefinition,
  sectionId: string,
  blockId: string,
  fn: (b: BlockNode, blocks: BlockNode[], i: number) => BlockNode[]
): ReduceResult {
  const at = locateSection(doc, sectionId);
  const blocks = at?.node.blocks ?? [];
  const i = blocks.findIndex(b => b.id === blockId);
  if (!at || i < 0) return { doc, rejected: 'NOT_FOUND' };
  return updateSection(doc, sectionId, n => ({ ...n, blocks: fn(blocks[i], blocks, i) }));
}

export function reduceDocument(doc: PageDefinition, action: DocumentAction): ReduceResult {
  switch (action.type) {
    case 'addSection': {
      const d = getSectionDefinition(action.sectionType);
      if (!d) return { doc, rejected: 'UNKNOWN_TYPE' };
      if (d.group !== action.list) return { doc, rejected: 'GROUP_MISMATCH' };
      if (countType(doc, d.type) >= d.maxCount) return { doc, rejected: 'CARDINALITY' };
      const id = uniqueSectionId(doc, d.type);
      const node = sectionFromPreset(d.type, action.presetIndex, id);
      const nodes = [...lists(doc)[action.list]];
      nodes.splice(action.index ?? nodes.length, 0, node);
      return { doc: withList(doc, action.list, nodes), createdId: id };
    }
    case 'removeSection': {
      const at = locateSection(doc, action.id);
      if (!at) return { doc, rejected: 'NOT_FOUND' };
      return {
        doc: withList(
          doc,
          at.list,
          lists(doc)[at.list].filter(n => n.id !== action.id)
        ),
      };
    }
    case 'duplicateSection': {
      const at = locateSection(doc, action.id);
      if (!at) return { doc, rejected: 'NOT_FOUND' };
      const d = getSectionDefinition(at.node.type);
      if (!d) return { doc, rejected: 'UNKNOWN_TYPE' };
      if (countType(doc, d.type) >= d.maxCount) return { doc, rejected: 'CARDINALITY' };
      const id = uniqueSectionId(doc, d.type);
      const copy: SectionNode = { ...clone(at.node), id };
      // A product carousel carries its own legacy id; it must be unique too.
      if (d.legacyKey === 'extraCarousels') copy.settings = { ...copy.settings, id };
      const nodes = [...lists(doc)[at.list]];
      nodes.splice(at.index + 1, 0, copy);
      return { doc: withList(doc, at.list, nodes), createdId: id };
    }
    case 'moveSection': {
      const at = locateSection(doc, action.id);
      if (!at) return { doc, rejected: 'NOT_FOUND' };
      return { doc: withList(doc, at.list, move(lists(doc)[at.list], at.index, action.toIndex)) };
    }
    case 'setSectionHidden':
      return updateSection(doc, action.id, n => ({ ...n, hidden: action.hidden }));
    case 'setSectionSetting':
      return updateSection(doc, action.id, n => ({
        ...n,
        settings: setKey(n.settings, action.key, action.value),
      }));
    case 'setViewportHidden':
    case 'setViewportSetting':
      return updateSection(doc, action.id, n => {
        const r = { ...(n.responsive ?? {}) };
        const vp = { ...(r[action.viewport] ?? {}) };
        if (action.type === 'setViewportHidden') {
          if (action.hidden === undefined) delete vp.hidden;
          else vp.hidden = action.hidden;
        } else {
          const settings = setKey(vp.settings ?? {}, action.key, action.value);
          if (Object.keys(settings).length > 0) vp.settings = settings;
          else delete vp.settings;
        }
        if (Object.keys(vp).length > 0) r[action.viewport] = vp;
        else delete r[action.viewport];
        const { responsive: _old, ...rest } = n;
        return Object.keys(r).length === 0 ? rest : { ...rest, responsive: r };
      });
    case 'addBlock': {
      const at = locateSection(doc, action.sectionId);
      if (!at) return { doc, rejected: 'NOT_FOUND' };
      const bd = getSectionDefinition(at.node.type)?.blocks.find(b => b.type === action.blockType);
      if (!bd) return { doc, rejected: 'BLOCK_NOT_SUPPORTED' };
      const blocks = at.node.blocks ?? [];
      if (blocks.filter(b => b.type === bd.type).length >= bd.maxCount)
        return { doc, rejected: 'CARDINALITY' };
      const id = uniqueBlockId(at.node, bd.type);
      const block: BlockNode = { id, type: bd.type, settings: {} };
      const r = updateSection(doc, action.sectionId, n => ({ ...n, blocks: [...blocks, block] }));
      return { ...r, createdId: id };
    }
    case 'removeBlock':
      return updateBlock(doc, action.sectionId, action.blockId, (_b, blocks, i) =>
        blocks.filter((_, j) => j !== i)
      );
    case 'duplicateBlock': {
      const at = locateSection(doc, action.sectionId);
      const src = at?.node.blocks?.find(b => b.id === action.blockId);
      if (!at || !src) return { doc, rejected: 'NOT_FOUND' };
      const bd = getSectionDefinition(at.node.type)?.blocks.find(b => b.type === src.type);
      const blocks = at.node.blocks ?? [];
      if (!bd || blocks.filter(b => b.type === src.type).length >= bd.maxCount)
        return { doc, rejected: 'CARDINALITY' };
      const id = uniqueBlockId(at.node, src.type);
      const r = updateBlock(doc, action.sectionId, action.blockId, (b, bl, i) => {
        const out = [...bl];
        out.splice(i + 1, 0, { ...clone(b), id });
        return out;
      });
      return { ...r, createdId: id };
    }
    case 'moveBlock':
      return updateBlock(doc, action.sectionId, action.blockId, (_b, blocks, i) =>
        move(blocks, i, action.toIndex)
      );
    case 'setBlockHidden':
      return updateBlock(doc, action.sectionId, action.blockId, (b, blocks, i) => {
        const out = [...blocks];
        out[i] = { ...b, hidden: action.hidden };
        return out;
      });
    case 'setBlockSetting':
      return updateBlock(doc, action.sectionId, action.blockId, (b, blocks, i) => {
        const out = [...blocks];
        out[i] = { ...b, settings: setKey(b.settings, action.key, action.value) };
        return out;
      });
  }
}
