/**
 * `PageDefinition` v1 — the versioned document the visual builder edits and
 * the storefront renders (visual builder Phase 1).
 *
 * Shape (structural; per-type props are checked against the registry in
 * `validate.ts`):
 *
 *   {
 *     schemaVersion: 1,
 *     pageKey: 'home',
 *     sections: [ { id, type, props, hidden?, responsive?, children? } ],
 *     siteSettings: { ...layout keys that are not sections (sizing, PLP/PDP pages, card defaults…) },
 *     legacy?: { sectionOrder?, absentSections? }   // lossless round trip to layout_settings
 *   }
 *
 * - `sections` is a TREE (`children`), but no v1 type declares a slot, so a
 *   v1 document is flat in practice.
 * - `hidden` hides the section everywhere; `responsive.<viewport>.hidden`
 *   hides it on one viewport (desktop / tablet / mobile, see VIEWPORT_RANGES);
 *   `responsive.<viewport>.props` overrides registry-declared props there.
 * - Colors are hex or THEME TOKEN REFERENCES (`token:primary` …) resolved
 *   against the store theme at render time; the document never copies theme
 *   values.
 * - RTL-aware: text is stored as bilingual pairs (`title` / `titleAr`, see
 *   each registry entry's `localizedProps`), alignment is logical only
 *   (`start` / `center` / `end` — `left`/`right` are rejected), and the
 *   document never stores a direction: the visitor's locale picks it.
 * - Price, stock and availability are NEVER stored here (NEVER-stale data
 *   stays in the API).
 */
import { z } from 'zod';

export const PAGE_DEFINITION_SCHEMA_VERSION = 1 as const;

export const BUILDER_LIMITS = {
  maxSections: 40,
  maxDocBytes: 256 * 1024,
  maxStringBytes: 2 * 1024,
  maxDepth: 2,
} as const;

/** Section ids: lowercase, digits, dashes. 64 allows `extra-<uuid>`. */
export const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECTION_TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const viewportOverrideSchema = z
  .object({
    hidden: z.boolean().optional(),
    props: z.record(z.unknown()).optional(),
  })
  .strict();

const responsiveSchema = z
  .object({
    desktop: viewportOverrideSchema.optional(),
    tablet: viewportOverrideSchema.optional(),
    mobile: viewportOverrideSchema.optional(),
  })
  .strict();

export interface SectionNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  hidden?: boolean;
  responsive?: z.infer<typeof responsiveSchema>;
  children?: SectionNode[];
}

export const sectionNodeSchema: z.ZodType<SectionNode> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(SECTION_ID_RE, 'Section id must be lowercase letters, digits or dashes'),
      type: z.string().regex(SECTION_TYPE_RE),
      props: z.record(z.unknown()),
      hidden: z.boolean().optional(),
      responsive: responsiveSchema.optional(),
      children: z.array(sectionNodeSchema).optional(),
    })
    .strict()
);

export const pageDefinitionSchema = z
  .object({
    schemaVersion: z.literal(PAGE_DEFINITION_SCHEMA_VERSION),
    pageKey: z.string().regex(PAGE_KEY_RE),
    sections: z.array(sectionNodeSchema).max(BUILDER_LIMITS.maxSections),
    siteSettings: z.record(z.unknown()),
    legacy: z
      .object({
        /** The raw saved `sectionOrder` (kept so an unedited round trip is byte-identical). */
        sectionOrder: z.array(z.string()).max(32).optional(),
        /** Optional layout keys that were absent (not `{}`) in the source layout. */
        absentSections: z.array(z.string()).max(32).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PageDefinition = z.infer<typeof pageDefinitionSchema>;
export type ViewportOverride = z.infer<typeof viewportOverrideSchema>;
