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
import { normalizeInlineText, textTargetIn } from './canvas-targets';

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
