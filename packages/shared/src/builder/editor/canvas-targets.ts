/**
 * Which settings of a section or block the canvas may edit in place, derived
 * from the registry (no second source of truth). Kept out of `registry.ts` so
 * parallel template work does not conflict with it.
 *
 *   TEXT_TARGETS   `text` / `textarea` settings, by section type and block type.
 *                  A localized setting contributes `id` (LTR) and `idAr` (RTL).
 *
 * The storefront overlay uses it to decide what a click may edit and in which
 * direction; the admin parent uses it to re-validate every `patch-text` intent
 * against the CURRENT document before dispatching (VE-2: intents, never data).
 */
import { SECTION_REGISTRY, type BlockDefinition } from '../registry';
import type { SettingDefinition } from '../settings-schema';
import type { PageDefinition, SectionNode } from '../schema';

export interface TextTarget {
  key: string;
  /** The direction of the FIELD (an `…Ar` key is RTL), not of the page. */
  dir: 'rtl' | 'ltr';
  /** `textarea` settings accept Shift+Enter newlines; `text` settings do not. */
  multiline: boolean;
}

export interface TextTargets {
  section: TextTarget[];
  blocks: Record<string, TextTarget[]>;
}

function textTargetsOf(settings: readonly SettingDefinition[]): TextTarget[] {
  const out: TextTarget[] = [];
  for (const s of settings) {
    if (s.type !== 'text' && s.type !== 'textarea') continue;
    const multiline = s.type === 'textarea';
    out.push({ key: s.id, dir: 'ltr', multiline });
    if (s.localized) out.push({ key: `${s.id}Ar`, dir: 'rtl', multiline });
  }
  return out;
}

const blockTargets = (blocks: readonly BlockDefinition[]): Record<string, TextTarget[]> =>
  Object.fromEntries(blocks.map(b => [b.type, textTargetsOf(b.settings)]));

export const TEXT_TARGETS: Readonly<Record<string, TextTargets>> = Object.fromEntries(
  SECTION_REGISTRY.map(d => [
    d.type,
    { section: textTargetsOf(d.settings), blocks: blockTargets(d.blocks) },
  ])
);

/** The text target `key` of a section type (or one of its block types), or null. */
export function textTarget(
  sectionType: string,
  blockType: string | undefined,
  key: string
): TextTarget | null {
  const t = TEXT_TARGETS[sectionType];
  if (!t) return null;
  const list = blockType === undefined ? t.section : (t.blocks[blockType] ?? []);
  return list.find(x => x.key === key) ?? null;
}

/** The node a canvas target names in `doc`: the section, plus the block when one is given. */
export function nodeFor(
  doc: PageDefinition,
  sectionId: string,
  blockId?: string
): { section: SectionNode; blockType?: string; settings: Record<string, unknown> } | null {
  const section = [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer].find(
    n => n.id === sectionId
  );
  if (!section) return null;
  if (blockId === undefined) return { section, settings: section.settings };
  const block = section.blocks?.find(b => b.id === blockId);
  return block ? { section, blockType: block.type, settings: block.settings } : null;
}

/** `textTarget` resolved against a real document node (the id must exist NOW). */
export function textTargetIn(
  doc: PageDefinition,
  sectionId: string,
  blockId: string | undefined,
  key: string
): TextTarget | null {
  const n = nodeFor(doc, sectionId, blockId);
  return n ? textTarget(n.section.type, n.blockType, key) : null;
}

/** Every text target of a node (used by the overlay's exact-match fallback). */
export function textTargetsIn(
  doc: PageDefinition,
  sectionId: string,
  blockId?: string
): TextTarget[] {
  const n = nodeFor(doc, sectionId, blockId);
  if (!n) return [];
  const t = TEXT_TARGETS[n.section.type];
  if (!t) return [];
  return n.blockType === undefined ? t.section : (t.blocks[n.blockType] ?? []);
}

export const MAX_INLINE_TEXT = 2048;

/** What an inline commit stores: capped, CRLF folded, and one line unless the field is a textarea. */
export function normalizeInlineText(value: string, multiline: boolean): string {
  const folded = value.replace(/\r\n?/g, '\n');
  const flat = multiline ? folded : folded.replace(/\s*\n\s*/g, ' ');
  return flat.trim().slice(0, MAX_INLINE_TEXT);
}
