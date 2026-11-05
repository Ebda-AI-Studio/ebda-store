/**
 * `ebda-builder:v1` — the postMessage protocol between the admin editor
 * (parent) and the storefront preview iframe (child), visual builder Phase 2.
 *
 *   parent -> child  `render`     { definition }          draw this document (unsaved edits)
 *   parent -> child  `select`     { sectionId, blockId? } outline a section
 *   parent -> child  `locale`     { locale }              (reload-free locale is not supported; informational)
 *   parent -> child  `focus`      { sectionId, blockId? } move keyboard focus onto that section's first target
 *   child  -> parent `focus-tree` {}                      Esc: give focus back to the tree
 *   child  -> parent `ready`      {}                      overlay mounted, send `render`
 *   child  -> parent `select`     { sectionId, blockId? } a section was clicked
 *   child  -> parent `hover`      { sectionId | null, blockId? }
 *   child  -> parent `patch-text` { sectionId, blockId?, key, value } inline text edit committed
 *   child  -> parent `section-op` { sectionId, blockId?, op }       toolbar button (move / duplicate / hide / remove)
 *   child  -> parent `move`       { sectionId, blockId?, toIndex }  a drag was dropped (final index in its own list)
 *   child  -> parent `request-add` { list, index }                  "+" between sections
 *   child  -> parent `open-admin`  { target }                      a canvas hint link ("add products"): the parent opens that admin page in a new tab
 *   child  -> parent `request-media` { sectionId, blockId?, key }  "change image" (names the target; the parent picks the file)
 *
 * Both sides accept a message ONLY when it parses here AND it comes from the
 * expected peer: the child checks `event.origin` against the admin origin it
 * was told about (and `event.source === window.parent`), the parent checks
 * `event.origin` against the storefront origin it framed and
 * `event.source === iframe.contentWindow`. A payload from anywhere else is
 * dropped without being read further.
 */
import { z } from 'zod/v3';
import { BUILDER_LIMITS, pageDefinitionSchema, SECTION_ID_RE } from '../schema';

export const BUILDER_PROTOCOL = 'ebda-builder:v1' as const;

const id = z.string().regex(SECTION_ID_RE);
/** A setting key: letters and digits only, never a path or markup. */
const settingKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/);
const base = { protocol: z.literal(BUILDER_PROTOCOL) };

/** Toolbar operations the canvas may ask for. `remove` always passes an in-app confirmation first. */
export const SECTION_OPS = ['moveUp', 'moveDown', 'duplicate', 'hide', 'remove', 'aiFill'] as const;
export type SectionOp = (typeof SECTION_OPS)[number];

/** Admin pages a canvas hint may send the merchant to (a closed list: the child never names a URL). */
export const ADMIN_TARGETS = ['products', 'categories'] as const;
export type AdminTarget = (typeof ADMIN_TARGETS)[number];

export const parentToChildSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('render'), definition: pageDefinitionSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal('select'),
      sectionId: id.nullable(),
      blockId: id.optional(),
    })
    .strict(),
  // Keyboard path: move focus to the first target of this section on the canvas (Enter on a tree row).
  z.object({ ...base, type: z.literal('focus'), sectionId: id, blockId: id.optional() }).strict(),
]);

export const childToParentSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready') }).strict(),
  // Keyboard path: Esc inside the canvas hands focus back to the tree.
  z.object({ ...base, type: z.literal('focus-tree') }).strict(),
  z.object({ ...base, type: z.literal('select'), sectionId: id, blockId: id.optional() }).strict(),
  z
    .object({ ...base, type: z.literal('hover'), sectionId: id.nullable(), blockId: id.optional() })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('patch-text'),
      sectionId: id,
      blockId: id.optional(),
      key: settingKey,
      value: z.string().max(2048),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('section-op'),
      sectionId: id,
      blockId: id.optional(),
      op: z.enum(SECTION_OPS),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('move'),
      sectionId: id,
      blockId: id.optional(),
      toIndex: z.number().int().min(0).max(BUILDER_LIMITS.maxBlocksPerSection),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('request-add'),
      list: z.enum(['header', 'template', 'footer']),
      index: z.number().int().min(0).max(BUILDER_LIMITS.maxSections),
    })
    .strict(),
  z.object({ ...base, type: z.literal('open-admin'), target: z.enum(ADMIN_TARGETS) }).strict(),
  z
    .object({
      ...base,
      type: z.literal('request-media'),
      sectionId: id,
      blockId: id.optional(),
      key: settingKey,
    })
    .strict(),
]);

export type ParentToChild = z.infer<typeof parentToChildSchema>;
export type ChildToParent = z.infer<typeof childToParentSchema>;

/** Strip trailing slashes and paths: `https://a.b/x/` -> `https://a.b`. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * Accept a message only from `expectedOrigin` and `expectedSource`, and only
 * when it parses. Returns the typed message or null.
 */
export function acceptMessage<T>(
  event: MessageLike,
  expectedOrigin: string | null,
  expectedSource: unknown,
  schema: z.ZodType<T>
): T | null {
  if (!expectedOrigin || event.origin !== expectedOrigin) return null;
  if (expectedSource == null || event.source !== expectedSource) return null;
  const parsed = schema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}
