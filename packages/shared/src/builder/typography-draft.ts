/**
 * Draft typography edits for the visual builder (Ruling VE-4: every edit is a draft until Publish).
 *
 * The font library and the global typography zones used to be written straight to
 * `stores.typography` (`PUT /typography`), so "Save" went live without Publish. They now travel in
 * the page document as `PageDefinition.typography`, a PATCH, and follow the lifecycle of the theme
 * patch (`theme-draft.ts`):
 *
 *   draft save   -> stored in the draft revision only (nothing public changes)
 *   publish      -> merged over `stores.typography` in the SAME statement as the `layout_settings`
 *                   back-write; the published revision keeps a full snapshot for rollback
 *   rollback     -> re-applies the target revision's snapshot (a revision with no `typography`
 *                   leaves the live typography alone)
 *
 * Shape: `fonts` is the WHOLE library (the editor sends it whole, like the PUT does); `zones` maps a
 * zone name to its override, or `null` to clear that zone. An absent patch changes nothing.
 */
import { z } from 'zod';
import { fontSourceSchema, zoneSchema } from '../schemas/typography';

/** Fonts the storefront loads must be https (the storefront emitter drops anything else). */
const httpsFont = fontSourceSchema.refine(f => f.url.startsWith('https://'), {
  message: 'font URL must be https',
});

const zoneNames = [
  'beforeHeader',
  'header',
  'storeName',
  'categories',
  'products',
  'footer',
  'afterFooter',
  'sectionKicker',
  'sectionTitle',
  'sectionSubtitle',
  'sectionSeeAll',
  'productName',
  'productPrice',
  'cta',
  'filters',
] as const;

export const draftTypographySchema = z
  .object({
    fonts: z.array(httpsFont).max(20).optional(),
    zones: z
      .object(
        Object.fromEntries(zoneNames.map(n => [n, zoneSchema.nullable().optional()])) as Record<
          (typeof zoneNames)[number],
          z.ZodOptional<z.ZodNullable<typeof zoneSchema>>
        >
      )
      .strict()
      .optional(),
  })
  .strict();

export type DraftTypography = z.infer<typeof draftTypographySchema>;

/** What `stores.typography` holds. */
export interface StoredTypography {
  fonts: Array<z.infer<typeof fontSourceSchema>>;
  zones: Record<string, z.infer<typeof zoneSchema>>;
}

export const hasTypographyPatch = (p: DraftTypography | undefined): p is DraftTypography =>
  !!p && (p.fonts !== undefined || (p.zones !== undefined && Object.keys(p.zones).length > 0));

/** `live` with the patch applied. Never mutates its inputs. */
export function applyTypographyPatch(
  live: unknown,
  patch: DraftTypography | undefined
): StoredTypography {
  const base = (live && typeof live === 'object' ? live : {}) as Partial<StoredTypography>;
  const zones: Record<string, z.infer<typeof zoneSchema>> = { ...(base.zones ?? {}) };
  for (const [name, zone] of Object.entries(patch?.zones ?? {})) {
    if (zone === null || zone === undefined) delete zones[name];
    else zones[name] = zone;
  }
  return { fonts: patch?.fonts ?? base.fonts ?? [], zones };
}

/** The typography the editor shows / the canvas paints: live with the draft patch on top. */
export const effectiveTypography = applyTypographyPatch;

/**
 * What a published revision records so a later rollback restores exactly this typography: the whole
 * blob after the patch. Every zone is listed, a zone with no override as `null`, so applying the
 * snapshot later CLEARS the zones that were not set when it was taken instead of leaving whatever the
 * live store has since gained.
 */
export function snapshotTypography(live: unknown, patch: DraftTypography): DraftTypography {
  const merged = applyTypographyPatch(live, patch);
  const zones = Object.fromEntries(zoneNames.map(n => [n, merged.zones[n] ?? null]));
  return { fonts: merged.fonts, zones } as DraftTypography;
}
