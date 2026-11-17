/**
 * Maps the API's field issues (JSON-pointer paths) onto the settings the right pane renders, so an
 * error shows under its own field and a summary can jump to it (editor premium F56).
 *
 * Paths look like `<sectionPath>/settings/<key>`, `<sectionPath>/blocks/<j>/settings/<key>` and
 * `<sectionPath>/responsive/<viewport>/settings/<key>`. A localized setting's Arabic twin is `<id>Ar`.
 */
export interface FieldIssue {
  path: string;
  messageEn: string;
  messageAr: string;
}

export interface ErrorTarget {
  /** Index in the section's `blocks`, or null for a section-level setting. */
  blockIndex: number | null;
  /** The setting key the issue is about, or null when the path names no setting. */
  key: string | null;
}

export function parseErrorTarget(path: string, sectionPath: string): ErrorTarget | null {
  if (!path.startsWith(sectionPath)) return null;
  const rest = path.slice(sectionPath.length);
  const block = /^\/blocks\/(\d+)(?:\/settings\/([^/]+))?/.exec(rest);
  if (block) return { blockIndex: Number(block[1]), key: block[2] ?? null };
  const setting = /^\/(?:responsive\/[^/]+\/)?settings\/([^/]+)/.exec(rest);
  return { blockIndex: null, key: setting ? setting[1] : null };
}

export interface FieldErrorGroups {
  /** Issues keyed by the setting definition id they belong to. */
  byDef: Record<string, FieldIssue[]>;
  /** Issues about this selection that no rendered field owns (still listed in the summary). */
  loose: FieldIssue[];
}

/**
 * @param blockIndex the selected block's index, or null when the section itself is selected
 * @param defs       the definitions the panel can render now (id + localized)
 */
export function groupFieldErrors(
  errors: readonly FieldIssue[],
  sectionPath: string,
  blockIndex: number | null,
  defs: ReadonlyArray<{ id: string; localized?: boolean }>
): FieldErrorGroups {
  const byDef: Record<string, FieldIssue[]> = {};
  const loose: FieldIssue[] = [];
  for (const e of errors) {
    const target = parseErrorTarget(e.path, sectionPath);
    if (!target) continue;
    // A block selected: only its own issues. The section selected: its settings, plus anything
    // about its blocks listed loosely, so nothing the API reported disappears.
    if (blockIndex !== null && target.blockIndex !== blockIndex) continue;
    if (blockIndex === null && target.blockIndex !== null) {
      loose.push(e);
      continue;
    }
    const def =
      target.key === null
        ? undefined
        : defs.find(d => d.id === target.key || (d.localized && `${d.id}Ar` === target.key));
    if (def) (byDef[def.id] ??= []).push(e);
    else loose.push(e);
  }
  return { byDef, loose };
}
