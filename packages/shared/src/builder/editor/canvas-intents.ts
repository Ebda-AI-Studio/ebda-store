/**
 * Canvas intents -> document actions (VE-2). The storefront overlay only ASKS
 * (`patch-text`, later `section-op`, `move`, ...); this is where the admin
 * parent re-validates each ask against the CURRENT document and the registry
 * and turns it into exactly one existing `DocumentAction`, or drops it.
 * Pure, so the whole table is unit-tested without a browser.
 */
import type { PageDefinition } from '../schema';
import type { DocumentAction } from './document-reducer';
import type { ChildToParent } from './protocol';
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
}

export function intentToAction(doc: PageDefinition, msg: ChildToParent): IntentResult | null {
  switch (msg.type) {
    case 'patch-text': {
      const target = textTargetIn(doc, msg.sectionId, msg.blockId, msg.key);
      if (!target) return null;
      const value = normalizeInlineText(msg.value, target.multiline);
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
    default:
      return null;
  }
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
  alt?: { en?: string; ar?: string }
): IntentResult[] {
  const coalesce = `${req.sectionId}/${req.blockId ?? ''}/image-swap`;
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
