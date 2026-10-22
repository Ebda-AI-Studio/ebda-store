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

/** The most any inline edit may carry (the protocol caps `patch-text` values at this). */
export const MAX_INLINE_TEXT = 2048;

export interface TextTarget {
  key: string;
  /** The direction of the FIELD (an `…Ar` key is RTL), not of the page. */
  dir: 'rtl' | 'ltr';
  /** `textarea` settings accept Shift+Enter newlines; `text` settings do not. */
  multiline: boolean;
  /** The save schema's own limit for this field (a step title is 80), else MAX_INLINE_TEXT. */
  max: number;
}

export interface ImageTarget {
  key: string;
  /** The image standard its size hint comes from (`IMAGE_STANDARDS`), when it has one. */
  standard?: 'heroDesktop' | 'heroMobile';
  /** Text settings that describe this picture (alt text), shown after a swap. */
  alt?: { en: string; ar?: string };
}

export interface TextTargets {
  section: TextTarget[];
  blocks: Record<string, TextTarget[]>;
}

/* ---- the save schema's limit for a field (read from the registry's Zod props) ---- */

type AnyZod = { shape?: Record<string, unknown>; element?: unknown; maxLength?: number | null } & {
  unwrap?: () => unknown;
  def?: { innerType?: unknown };
};
const unwrapZod = (schema: unknown): AnyZod | undefined => {
  let x = schema as AnyZod | undefined;
  for (let i = 0; i < 6 && x; i++) {
    if (typeof x.unwrap === 'function') x = x.unwrap() as AnyZod;
    else if (x.def?.innerType) x = x.def.innerType as AnyZod;
    else break;
  }
  return x;
};
/** The Zod string limit of `shape[key]`, or null when the field has none. */
const stringLimit = (shape: Record<string, unknown> | undefined, key: string): number | null => {
  const f = unwrapZod(shape?.[key]);
  return typeof f?.maxLength === 'number' ? f.maxLength : null;
};
/** Block settings live in the block's own schema, or in an array field of the section's (hero slides). */
function blockShape(
  d: { propsSchema?: unknown; blocks: readonly BlockDefinition[] },
  b: BlockDefinition
) {
  const own = unwrapZod(b.propsSchema)?.shape;
  if (own) return own;
  const section = unwrapZod(d.propsSchema)?.shape ?? {};
  for (const v of Object.values(section)) {
    const el = unwrapZod(unwrapZod(v)?.element)?.shape;
    if (el && b.settings.some(s => s.id in el)) return el;
  }
  return undefined;
}

function textTargetsOf(
  settings: readonly SettingDefinition[],
  shape?: Record<string, unknown>
): TextTarget[] {
  const out: TextTarget[] = [];
  for (const s of settings) {
    if (s.type !== 'text' && s.type !== 'textarea') continue;
    const multiline = s.type === 'textarea';
    const max = (k: string) => Math.min(stringLimit(shape, k) ?? MAX_INLINE_TEXT, MAX_INLINE_TEXT);
    out.push({ key: s.id, dir: 'ltr', multiline, max: max(s.id) });
    if (s.localized) out.push({ key: `${s.id}Ar`, dir: 'rtl', multiline, max: max(`${s.id}Ar`) });
  }
  return out;
}

const blockTargets = (d: {
  propsSchema?: unknown;
  blocks: readonly BlockDefinition[];
}): Record<string, TextTarget[]> =>
  Object.fromEntries(d.blocks.map(b => [b.type, textTargetsOf(b.settings, blockShape(d, b))]));

export const TEXT_TARGETS: Readonly<Record<string, TextTargets>> = Object.fromEntries(
  SECTION_REGISTRY.map(d => [
    d.type,
    {
      section: textTargetsOf(d.settings, unwrapZod(d.propsSchema)?.shape),
      blocks: blockTargets(d),
    },
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

/** What an inline commit stores: capped, CRLF folded, and one line unless the field is a textarea. */
export function normalizeInlineText(
  value: string,
  multiline: boolean,
  max: number = MAX_INLINE_TEXT
): string {
  const folded = value.replace(/\r\n?/g, '\n');
  const flat = multiline ? folded : folded.replace(/\s*\n\s*/g, ' ');
  return flat.trim().slice(0, Math.min(max, MAX_INLINE_TEXT));
}

/**
 * `image` settings a click on a picture may replace, by section type and block
 * type. A localized image contributes `id` and `idAr`. The picture itself never
 * travels over the protocol: the child names the target and the PARENT picks
 * the file from the store's own media (`request-media`).
 */
const SIZE_STANDARD: Record<string, ImageTarget['standard']> = {
  'hero/slide/image': 'heroDesktop',
  'hero/slide/imageAr': 'heroDesktop',
  'hero/slide/imageMobile': 'heroMobile',
  'hero/slide/imageMobileAr': 'heroMobile',
};

function imageTargetsOf(scope: string, settings: readonly SettingDefinition[]): ImageTarget[] {
  const alt = settings.find(s => s.id === 'alt' && s.type === 'text');
  const out: ImageTarget[] = [];
  for (const s of settings) {
    if (s.type !== 'image') continue;
    const mk = (key: string): ImageTarget => ({
      key,
      standard: SIZE_STANDARD[`${scope}/${key}`],
      // Only the main picture owns the alt text; a mobile variant shares it.
      ...(alt && s.id === 'image'
        ? { alt: alt.localized ? { en: 'alt', ar: 'altAr' } : { en: 'alt' } }
        : {}),
    });
    out.push(mk(s.id));
    if (s.localized) out.push(mk(`${s.id}Ar`));
  }
  return out;
}

export const IMAGE_TARGETS: Readonly<
  Record<string, { section: ImageTarget[]; blocks: Record<string, ImageTarget[]> }>
> = Object.fromEntries(
  SECTION_REGISTRY.map(d => [
    d.type,
    {
      section: imageTargetsOf(d.type, d.settings),
      blocks: Object.fromEntries(
        d.blocks.map(b => [b.type, imageTargetsOf(`${d.type}/${b.type}`, b.settings)])
      ),
    },
  ])
);

/** The image target `key` of a real node in `doc`, or null (unknown id, not an image setting). */
export function imageTargetIn(
  doc: PageDefinition,
  sectionId: string,
  blockId: string | undefined,
  key: string
): ImageTarget | null {
  const n = nodeFor(doc, sectionId, blockId);
  if (!n) return null;
  const t = IMAGE_TARGETS[n.section.type];
  if (!t) return null;
  const list = n.blockType === undefined ? t.section : (t.blocks[n.blockType] ?? []);
  return list.find(x => x.key === key) ?? null;
}
