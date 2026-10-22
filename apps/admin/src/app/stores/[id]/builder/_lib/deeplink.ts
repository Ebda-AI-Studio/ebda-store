/**
 * The editor's deep link (Task 11): `/stores/:id/builder?select=<sectionId|type|theme|history>
 * &block=<blockId|type>&field=<id>&page=<kind>`. It is what ⌘K and a pasted URL use to land on a
 * section with one field highlighted. The query string is untrusted input: every value is
 * shape-checked, an unknown id or type is ignored, and nothing here ever throws.
 */
import type { PageDefinition, SectionNode } from '@ebda/shared';
import type { Selection } from '../_components/SectionTree';

/** Start-pane tabs a link can open instead of a section. */
const TAB_TOKENS = { theme: 'theme', history: 'history' } as const;

/** An id, a section type, a registry id (`builder.header-logo`) or a setting id: short, plain. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Registry ids of generated section fields -> the settings-schema field id they anchor. */
const FIELD_ALIASES: Record<string, string> = {
  'builder.section-typography': 'typography',
  'builder.dividers': 'dividers',
  'builder.video': 'video',
};

/** The settings-schema field id a deep link's `field` stands for (itself unless it is a registry id). */
export const fieldDefId = (field: string): string =>
  Object.prototype.hasOwnProperty.call(FIELD_ALIASES, field) ? FIELD_ALIASES[field]! : field;

export interface DeepLinkParams {
  select?: string;
  block?: string;
  field?: string;
}

export interface DeepLinkTarget {
  /** Start-pane tab to open (theme and history exist on their own, not on a section). */
  tab?: 'theme' | 'history';
  selection?: Selection;
  /** The control to scroll to and ring, once the right pane has rendered it. */
  field?: string;
}

const clean = (v: string | null | undefined): string | undefined =>
  typeof v === 'string' && TOKEN.test(v) ? v : undefined;

/** Read `select`, `block` and `field`; anything that is not a plain token is dropped. */
export function parseDeepLink(search: { get(name: string): string | null } | null): DeepLinkParams {
  if (!search) return {};
  const out: DeepLinkParams = {};
  const select = clean(search.get('select'));
  const block = clean(search.get('block'));
  const field = clean(search.get('field'));
  if (select) out.select = select;
  if (block) out.block = block;
  if (field) out.field = field;
  return out;
}

function allSections(doc: PageDefinition): SectionNode[] {
  return [...doc.sections, ...doc.sectionGroups.header, ...doc.sectionGroups.footer];
}

/**
 * Resolve a link against the open document. `select` matches a section id first, then the first
 * section of that type (page body, then header, then footer). A link that matches nothing yields
 * no selection (the editor opens as usual); `field` still rides along so a control that is on
 * screen anyway (the theme tab, the page settings) is found.
 */
export function resolveDeepLink(
  doc: PageDefinition | null | undefined,
  params: DeepLinkParams,
  opts: { canOpenTheme?: boolean } = {}
): DeepLinkTarget {
  const target: DeepLinkTarget = {};
  try {
    if (params.field) target.field = params.field;
    const { select } = params;
    if (!select) return target;
    if (Object.prototype.hasOwnProperty.call(TAB_TOKENS, select)) {
      const tab = TAB_TOKENS[select as keyof typeof TAB_TOKENS];
      if (tab !== 'theme' || opts.canOpenTheme !== false) target.tab = tab;
      return target;
    }
    if (!doc) return target;
    const sections = allSections(doc);
    const node = sections.find(s => s.id === select) ?? sections.find(s => s.type === select);
    if (!node) return target;
    const blockWanted = params.block;
    const block = blockWanted
      ? ((node.blocks ?? []).find(b => b.id === blockWanted) ??
        (node.blocks ?? []).find(b => b.type === blockWanted))
      : undefined;
    target.selection = block ? { sectionId: node.id, blockId: block.id } : { sectionId: node.id };
  } catch {
    // untrusted input must never break the editor: fall back to what was resolved so far
  }
  return target;
}
