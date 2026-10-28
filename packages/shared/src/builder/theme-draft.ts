/**
 * Draft theme edits for the visual builder.
 *
 * The editor's global theme settings (`THEME_SETTINGS_SCHEMA`) used to be
 * written straight to `stores.theme` (the LIVE column the storefront reads),
 * so "Save theme" went live without Publish and the canvas read the cached
 * live store. They now travel in the page document as `PageDefinition.theme`
 * — a PATCH of editor-managed keys — so they ride the same draft / publish /
 * rollback lifecycle as the sections:
 *
 *   draft save   -> stored in the draft revision only (nothing public changes)
 *   publish      -> merged over `stores.theme` in the SAME transaction as the
 *                   `layout_settings` back-write; the published revision keeps
 *                   a full snapshot of the editor-managed keys for rollback
 *   rollback     -> re-applies the target revision's snapshot (a revision with
 *                   no `theme` leaves the live theme untouched)
 *
 * Only keys the editor's schema declares are accepted, with the value type the
 * setting declares — this is a smaller surface than the legacy theme PUT.
 */
import { z } from 'zod/v3';
import { THEME_SETTINGS_SCHEMA } from './settings-schema';

const EDITABLE = new Map<string, 'string' | 'boolean'>();
for (const g of THEME_SETTINGS_SCHEMA)
  for (const s of g.settings)
    EDITABLE.set(String(s.id), s.type === 'checkbox' ? 'boolean' : 'string');

/**
 * Colour tokens Smart Palette DERIVES from the brand colours (`deriveCoreBrandTokens`): the text
 * colour on each brand fill and the input border. They have no control of their own, so they are not
 * in `THEME_SETTINGS_SCHEMA`, but a palette applied in the editor must be able to put them in the
 * draft or the live theme would end up half-updated at publish.
 */
export const DERIVED_THEME_KEYS = [
  'inputColor',
  'primaryForeground',
  'secondaryForeground',
  'accentForeground',
  'cardForeground',
] as const;
for (const k of DERIVED_THEME_KEYS) EDITABLE.set(k, 'string');

/** Theme keys the visual editor may put in a draft. */
export const DRAFT_THEME_KEYS: readonly string[] = [...EDITABLE.keys()];

/**
 * `null` is "reset this key": at publish the key is removed from the live theme so the look's own
 * default shows again (the editor's "reset to the look default"). It is a draft edit like any other.
 */
export const draftThemeSchema = z
  .record(z.union([z.string().max(100), z.boolean(), z.null()]))
  .superRefine((theme, ctx) => {
    for (const [key, value] of Object.entries(theme)) {
      const kind = EDITABLE.get(key);
      if (!kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `"${key}" is not an editable theme setting`,
        });
      } else if (value !== null && typeof value !== kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `"${key}" must be a ${kind}`,
        });
      }
    }
  });

export type DraftTheme = z.infer<typeof draftThemeSchema>;

/** `live` with the patch applied: a `null` removes the key. Never mutates its inputs. */
export function applyThemePatch<T extends object>(
  live: T | null | undefined,
  patch: DraftTheme | undefined
): T {
  const out = { ...(live ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out as T;
}

/** The theme the editor shows / the canvas paints: live theme with the draft patch on top. */
export function effectiveTheme<T extends object>(
  live: T | null | undefined,
  patch: DraftTheme | undefined
): T {
  return applyThemePatch(live, patch);
}

/**
 * Full snapshot of the editor-managed keys after applying `patch` over `live`
 * — what a published revision records so a later rollback restores exactly
 * these keys (a bare patch would only restore the keys that revision changed).
 * A key the patch reset is recorded as `null`, so rolling back removes it again.
 */
export function snapshotEditableTheme(
  live: Record<string, unknown> | null | undefined,
  patch: DraftTheme
): DraftTheme {
  const merged = applyThemePatch(live, patch) as Record<string, unknown>;
  const out: DraftTheme = {};
  for (const key of DRAFT_THEME_KEYS) {
    const v = merged[key];
    if (typeof v === 'string' || typeof v === 'boolean') out[key] = v;
    else if (patch[key] === null) out[key] = null;
  }
  return out;
}
