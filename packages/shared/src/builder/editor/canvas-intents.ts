/**
 * Canvas intents -> document actions (VE-2). The storefront overlay only ASKS
 * (`patch-text`, later `section-op`, `move`, ...); this is where the admin
 * parent re-validates each ask against the CURRENT document and the registry
 * and turns it into exactly one existing `DocumentAction`, or drops it.
 * Pure, so the whole table is unit-tested without a browser.
 */
import type { PageDefinition } from '../schema';
import { locateSection, type DocumentAction, type SectionList } from './document-reducer';
import type { ChildToParent, SectionOp } from './protocol';
import {
  imageTargetIn,
  nodeFor,
  normalizeInlineText,
  textTargetIn,
  type ImageTarget,
} from './canvas-targets';

export interface IntentResult {
  action: DocumentAction;
  /** Undo coalescing key: consecutive edits to one field are one undo step. */
  coalesce?: string;
  /** The parent must get an in-app confirmation before dispatching (destructive). */
  confirm?: 'remove';
}

export function intentToAction(doc: PageDefinition, msg: ChildToParent): IntentResult | null {
  switch (msg.type) {
    case 'patch-text': {
      const target = textTargetIn(doc, msg.sectionId, msg.blockId, msg.key);
      if (!target) return null;
      const value = normalizeInlineText(msg.value, target.multiline, target.max);
      const coalesce = `${msg.sectionId}/${msg.blockId ?? ''}/${msg.key}`;
      return {
        action: msg.blockId
          ? {
              type: 'setBlockSetting',
              sectionId: msg.sectionId,
              blockId: msg.blockId,
              key: msg.key,
              value,
            }
          : { type: 'setSectionSetting', id: msg.sectionId, key: msg.key, value },
        coalesce,
      };
    }
    case 'section-op':
      return sectionOpAction(doc, msg.sectionId, msg.blockId, msg.op);
    case 'move': {
      const at = locate(doc, msg.sectionId, msg.blockId);
      // The canvas only offers these for page sections; the parent does not take its word for it.
      if (!at || !isPageSection(doc, msg.sectionId)) return null;
      const toIndex = Math.min(msg.toIndex, at.count - 1);
      if (toIndex === at.index) return null; // dropped where it already is: no history entry
      return {
        action: msg.blockId
          ? { type: 'moveBlock', sectionId: msg.sectionId, blockId: msg.blockId, toIndex }
          : { type: 'moveSection', id: msg.sectionId, toIndex },
      };
    }
    default:
      return null;
  }
}

/** Header, announcement bar and footer are chrome, edited in the panes: no canvas toolbar acts on them. */
function isPageSection(doc: PageDefinition, sectionId: string): boolean {
  return locateSection(doc, sectionId)?.list === 'template';
}

/** Where a section (or one of its blocks) sits in its own list. */
function locate(
  doc: PageDefinition,
  sectionId: string,
  blockId?: string
): { index: number; count: number } | null {
  const at = locateSection(doc, sectionId);
  if (!at) return null;
  if (blockId === undefined) {
    const list = at.list === 'template' ? doc.sections : doc.sectionGroups[at.list];
    return { index: at.index, count: list.length };
  }
  const blocks = at.node.blocks ?? [];
  const index = blocks.findIndex(b => b.id === blockId);
  return index < 0 ? null : { index, count: blocks.length };
}

function sectionOpAction(
  doc: PageDefinition,
  sectionId: string,
  blockId: string | undefined,
  op: SectionOp
): IntentResult | null {
  const at = locate(doc, sectionId, blockId);
  if (!at || !isPageSection(doc, sectionId)) return null;
  switch (op) {
    case 'moveUp':
    case 'moveDown': {
      const toIndex = at.index + (op === 'moveUp' ? -1 : 1);
      if (toIndex < 0 || toIndex >= at.count) return null; // at the end of its list: nothing to do
      return {
        action: blockId
          ? { type: 'moveBlock', sectionId, blockId, toIndex }
          : { type: 'moveSection', id: sectionId, toIndex },
      };
    }
    case 'duplicate':
      return {
        action: blockId
          ? { type: 'duplicateBlock', sectionId, blockId }
          : { type: 'duplicateSection', id: sectionId },
      };
    case 'hide':
      return {
        action: blockId
          ? { type: 'setBlockHidden', sectionId, blockId, hidden: true }
          : { type: 'setSectionHidden', id: sectionId, hidden: true },
      };
    case 'aiFill':
      // Not a document action: the parent asks the API, then dispatches the fills (`aiFillActions`).
      return null;
    case 'remove':
      return {
        action: blockId
          ? { type: 'removeBlock', sectionId, blockId }
          : { type: 'removeSection', id: sectionId },
        confirm: 'remove',
      };
  }
}

/** A validated "+" request: the list is a real group and the index is inside it (inserting at the end is allowed). */
export interface AddRequest {
  list: SectionList;
  index: number;
}

export function addRequestFor(doc: PageDefinition, msg: ChildToParent): AddRequest | null {
  if (msg.type !== 'request-add') return null;
  const nodes = msg.list === 'template' ? doc.sections : doc.sectionGroups[msg.list];
  if (msg.index > nodes.length) return null;
  return { list: msg.list, index: msg.index };
}

/** A validated "change this image" request, ready for the parent's media picker. */
export interface MediaRequest {
  sectionId: string;
  blockId?: string;
  key: string;
  target: ImageTarget;
  /** The current alt text (en / ar), when the setting has an alt sibling. */
  alt?: { en: string; ar?: string };
}

/** `request-media` re-checked against the CURRENT document: the key must be an image setting of that node. */
export function mediaRequestFor(doc: PageDefinition, msg: ChildToParent): MediaRequest | null {
  if (msg.type !== 'request-media') return null;
  const target = imageTargetIn(doc, msg.sectionId, msg.blockId, msg.key);
  if (!target) return null;
  const settings = nodeFor(doc, msg.sectionId, msg.blockId)?.settings ?? {};
  const str = (k: string | undefined) =>
    k && typeof settings[k] === 'string' ? (settings[k] as string) : '';
  return {
    sectionId: msg.sectionId,
    ...(msg.blockId ? { blockId: msg.blockId } : {}),
    key: msg.key,
    target,
    ...(target.alt
      ? { alt: { en: str(target.alt.en), ...(target.alt.ar ? { ar: str(target.alt.ar) } : {}) } }
      : {}),
  };
}

/** The actions that store a picked image (and its alt text, when given): one undo step via one coalesce key. */
export function imageSwapActions(
  req: Pick<MediaRequest, 'sectionId' | 'blockId' | 'key' | 'target'>,
  url: string,
  alt?: { en?: string; ar?: string },
  /** One value per swap: two swaps of the same picture are two undo steps. */
  nonce: string | number = ''
): IntentResult[] {
  const coalesce = `${req.sectionId}/${req.blockId ?? ''}/image-swap/${nonce}`;
  const set = (key: string, value: string): IntentResult => ({
    action: req.blockId
      ? { type: 'setBlockSetting', sectionId: req.sectionId, blockId: req.blockId, key, value }
      : { type: 'setSectionSetting', id: req.sectionId, key, value },
    coalesce,
  });
  const out = [set(req.key, url)];
  if (alt && req.target.alt) {
    if (alt.en !== undefined) out.push(set(req.target.alt.en, alt.en.trim().slice(0, 300)));
    if (alt.ar !== undefined && req.target.alt.ar)
      out.push(set(req.target.alt.ar, alt.ar.trim().slice(0, 300)));
  }
  return out;
}

/**
 * Sections the AI can write a kicker and subtitle for, by the name the API knows them by
 * (`POST /stores/:id/ai/section-content`). Everything else gets no AI button.
 */
export const AI_FILL_SECTIONS: Readonly<Record<string, string>> = {
  'category-grid': 'categories',
  'new-arrivals': 'newArrivals',
  'best-sellers': 'bestSellers',
  'featured-collection': 'featured',
  testimonials: 'testimonials',
  // T7 signature sections: the same kicker + subtitle fill, grounded in the section's own title.
  'editorial-collage': 'signature',
  'piece-window': 'signature',
  'spec-sheet': 'signature',
  'key-ingredients': 'signature',
  'kitchen-days': 'signature',
};

export interface AiFillRequest {
  sectionId: string;
  /** The API's name for the section. */
  section: string;
  existingTitle?: string;
  existingTitleAr?: string;
}

/** `section-op aiFill` re-checked against the current document: a page section the AI supports. */
export function aiFillRequestFor(doc: PageDefinition, msg: ChildToParent): AiFillRequest | null {
  if (msg.type !== 'section-op' || msg.op !== 'aiFill' || msg.blockId) return null;
  return aiFillRequestForSection(doc, msg.sectionId);
}

export function aiFillRequestForSection(
  doc: PageDefinition,
  sectionId: string
): AiFillRequest | null {
  const at = locateSection(doc, sectionId);
  if (!at || at.list !== 'template') return null;
  const section = AI_FILL_SECTIONS[at.node.type];
  if (!section) return null;
  const str = (k: string) =>
    typeof at.node.settings[k] === 'string' && (at.node.settings[k] as string).trim()
      ? (at.node.settings[k] as string)
      : undefined;
  return { sectionId, section, existingTitle: str('title'), existingTitleAr: str('titleAr') };
}

export interface AiSuggestion {
  kicker: string;
  kickerAr: string;
  subtitle: string;
  subtitleAr: string;
}

/**
 * The fills for an AI suggestion: text settings of that section only, and only the ones that are
 * EMPTY now (a merchant's own words are never overwritten). One coalesce key per fill, so the whole
 * fill is one undo step. Empty result = nothing to fill.
 */
export function aiFillActions(
  doc: PageDefinition,
  sectionId: string,
  suggestion: AiSuggestion,
  nonce: string | number = ''
): IntentResult[] {
  const node = locateSection(doc, sectionId)?.node;
  if (!node) return [];
  const out: IntentResult[] = [];
  for (const key of ['kicker', 'kickerAr', 'subtitle', 'subtitleAr'] as const) {
    const target = textTargetIn(doc, sectionId, undefined, key);
    const current = node.settings[key];
    const next = typeof suggestion[key] === 'string' ? suggestion[key].trim() : '';
    if (!target || !next) continue;
    if (typeof current === 'string' && current.trim()) continue;
    out.push({
      action: {
        type: 'setSectionSetting',
        id: sectionId,
        key,
        value: normalizeInlineText(next, false, target.max),
      },
      coalesce: `${sectionId}/ai-fill/${nonce}`,
    });
  }
  return out;
}
