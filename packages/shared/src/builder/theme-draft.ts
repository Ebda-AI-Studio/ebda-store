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
import { z } from 'zod';
import { THEME_SETTINGS_SCHEMA } from './settings-schema';

const EDITABLE = new Map<string, 'string' | 'boolean'>();
for (const g of THEME_SETTINGS_SCHEMA)
  for (const s of g.settings)
    // `dividers` is a classic-builder-only control (not a scalar value).
    if (s.type !== 'dividers')
      EDITABLE.set(String(s.id), s.type === 'checkbox' ? 'boolean' : 'string');

/** Theme keys the visual editor may put in a draft. */
export const DRAFT_THEME_KEYS: readonly string[] = [...EDITABLE.keys()];

export const draftThemeSchema = z
  .record(z.union([z.string().max(100), z.boolean()]))
  .superRefine((theme, ctx) => {
    for (const [key, value] of Object.entries(theme)) {
      const kind = EDITABLE.get(key);
      if (!kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `"${key}" is not an editable theme setting`,
        });
      } else if (typeof value !== kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `"${key}" must be a ${kind}`,
        });
      }
    }
  });

export type DraftTheme = z.infer<typeof draftThemeSchema>;

/** The theme the editor shows / the canvas paints: live theme with the draft patch on top. */
export function effectiveTheme<T extends object>(
  live: T | null | undefined,
  patch: DraftTheme | undefined
): T {
  return { ...(live ?? {}), ...(patch ?? {}) } as T;
}

/**
 * Full snapshot of the editor-managed keys after applying `patch` over `live`
 * — what a published revision records so a later rollback restores exactly
 * these keys (a bare patch would only restore the keys that revision changed).
 */
export function snapshotEditableTheme(
  live: Record<string, unknown> | null | undefined,
  patch: DraftTheme
): DraftTheme {
  const merged = { ...(live ?? {}), ...patch } as Record<string, unknown>;
  const out: DraftTheme = {};
  for (const key of DRAFT_THEME_KEYS) {
    const v = merged[key];
    if (typeof v === 'string' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
