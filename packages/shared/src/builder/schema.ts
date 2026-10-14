/**
 * `PageDefinition` v1 — the versioned document the visual builder edits and
 * the storefront renders (visual builder Phase 1).
 *
 * Shopify-theme-editor model (Ahmad, 2026-10-07): a page TEMPLATE is an
 * ordered list of SECTIONS; a section holds ordered BLOCKS; every section and
 * block type declares a settings SCHEMA (`settings-schema.ts`) that drives
 * the editor's auto-generated settings panel; the header and footer are
 * SECTION GROUPS shared by every page.
 *
 *   {
 *     schemaVersion: 1,
 *     pageKey: 'home',
 *     sectionGroups: { header: [section…], footer: [section…] },
 *     sections: [ { id, type, settings, blocks?, hidden?, responsive? } ],
 *     siteSettings: { …layout keys that are not sections (sizing, PLP/PDP pages, card defaults…) },
 *     legacy?: { sectionOrder?, absentSections? }   // lossless round trip to layout_settings
 *   }
 *
 * - `hidden` hides a section/block everywhere; `responsive.<viewport>.hidden`
 *   hides it on one viewport (desktop / tablet / mobile, see VIEWPORT_RANGES);
 *   `responsive.<viewport>.settings` overrides the settings a type declares
 *   responsive.
 * - Colors are hex or THEME TOKEN REFERENCES (`token:primary` …) resolved
 *   against the store theme at render time. The theme itself (colors,
 *   typography, buttons, spacing) lives on the store (`stores.theme`, global
 *   `THEME_SETTINGS_SCHEMA`); the document only carries the editor's PENDING
 *   edits to it in the optional `theme` patch (`theme-draft.ts`), which publish
 *   promotes to `stores.theme` and a draft never exposes publicly.
 * - Dynamic data is bound by REFERENCE only (category slug, product ids),
 *   resolved against the caller's store; price, stock and availability are
 *   NEVER stored here.
 * - RTL-aware: text is stored as bilingual pairs (`title` / `titleAr`,
 *   declared `localized` in the settings schema), alignment is logical only
 *   (`start` / `center` / `end` — `left`/`right` are rejected), and the
 *   document never stores a direction: the visitor's locale picks it.
 */
import { z } from 'zod';
import { draftThemeSchema } from './theme-draft';

export const PAGE_DEFINITION_SCHEMA_VERSION = 1 as const;

export const BUILDER_LIMITS = {
  maxSections: 40,
  maxBlocksPerSection: 50,
  maxDocBytes: 256 * 1024,
  maxStringBytes: 2 * 1024,
} as const;

/** Section / block ids: lowercase, digits, dashes. 64 allows `extra-<uuid>`. */
export const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const viewportOverrideSchema = z
  .object({
    hidden: z.boolean().optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();

const responsiveSchema = z
  .object({
    desktop: viewportOverrideSchema.optional(),
    tablet: viewportOverrideSchema.optional(),
    mobile: viewportOverrideSchema.optional(),
  })
  .strict();

export const blockNodeSchema = z
  .object({
    id: z.string().regex(SECTION_ID_RE, 'Block id must be lowercase letters, digits or dashes'),
    type: z.string().regex(TYPE_RE),
    settings: z.record(z.unknown()),
    hidden: z.boolean().optional(),
  })
  .strict();

export const sectionNodeSchema = z
  .object({
    id: z.string().regex(SECTION_ID_RE, 'Section id must be lowercase letters, digits or dashes'),
    type: z.string().regex(TYPE_RE),
    settings: z.record(z.unknown()),
    blocks: z.array(blockNodeSchema).max(BUILDER_LIMITS.maxBlocksPerSection).optional(),
    hidden: z.boolean().optional(),
    responsive: responsiveSchema.optional(),
  })
  .strict();

export const pageDefinitionSchema = z
  .object({
    schemaVersion: z.literal(PAGE_DEFINITION_SCHEMA_VERSION),
    pageKey: z.string().regex(PAGE_KEY_RE),
    sectionGroups: z
      .object({
        header: z.array(sectionNodeSchema).max(8),
        footer: z.array(sectionNodeSchema).max(8),
      })
      .strict(),
    sections: z.array(sectionNodeSchema).max(BUILDER_LIMITS.maxSections),
    siteSettings: z.record(z.unknown()),
    /** Draft/published theme PATCH (editor-managed keys only, see `theme-draft.ts`). */
    theme: draftThemeSchema.optional(),
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
export type SectionNode = z.infer<typeof sectionNodeSchema>;
export type BlockNode = z.infer<typeof blockNodeSchema>;
export type ViewportOverride = z.infer<typeof viewportOverrideSchema>;
export type SectionGroupKey = keyof PageDefinition['sectionGroups'];
