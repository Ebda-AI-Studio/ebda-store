/**
 * `ebda-builder:v1` — the postMessage protocol between the admin editor
 * (parent) and the storefront preview iframe (child), visual builder Phase 2.
 *
 *   parent -> child  `render`     { definition }          draw this document (unsaved edits)
 *   parent -> child  `select`     { sectionId, blockId? } outline a section
 *   parent -> child  `locale`     { locale }              (reload-free locale is not supported; informational)
 *   child  -> parent `ready`      {}                      overlay mounted, send `render`
 *   child  -> parent `select`     { sectionId, blockId? } a section was clicked
 *   child  -> parent `hover`      { sectionId | null, blockId? }
 *   child  -> parent `patch-text` { sectionId, blockId?, key, value } inline text edit committed
 *
 * Both sides accept a message ONLY when it parses here AND it comes from the
 * expected peer: the child checks `event.origin` against the admin origin it
 * was told about (and `event.source === window.parent`), the parent checks
 * `event.origin` against the storefront origin it framed and
 * `event.source === iframe.contentWindow`. A payload from anywhere else is
 * dropped without being read further.
 */
import { z } from 'zod';
import { pageDefinitionSchema, SECTION_ID_RE } from '../schema';

export const BUILDER_PROTOCOL = 'ebda-builder:v1' as const;

const id = z.string().regex(SECTION_ID_RE);
const base = { protocol: z.literal(BUILDER_PROTOCOL) };

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
]);

export const childToParentSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready') }).strict(),
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
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/),
      value: z.string().max(2048),
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
