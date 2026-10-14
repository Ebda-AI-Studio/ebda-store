/**
 * Re-base a pending visual-editor draft onto a new LIVE page document.
 *
 * The classic builder's Save is its Publish (it writes a new published
 * revision through `PUT /layout`). A merchant may have unpublished visual work
 * in a draft at that moment. Leaving the draft as it was means the next
 * Publish of it silently reverts the classic edit; discarding it loses the
 * merchant's work. Instead (Ruling CLASSIC-SAVE-DRAFT-1) the classic edit is
 * MERGED into the draft: only what the classic save actually changed
 * (`previousLive` -> `nextLive`) is applied, everything else the draft holds
 * stays exactly as the merchant left it.
 *
 * Granularity: per section id, then per field (`settings.<key>`, `blocks`,
 * `hidden`, `responsive`); per `siteSettings` key; section order when the
 * classic save reordered. The draft's `theme` and `chrome` patches are never
 * touched (the classic builder does not author them). A section the classic
 * save changed that the draft has deleted stays deleted; a section the classic
 * save added is added.
 */
import type { PageDefinition, SectionNode } from './schema';

type Group = 'header' | 'footer' | 'template';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function index(def: PageDefinition): Map<string, { node: SectionNode; group: Group }> {
  const out = new Map<string, { node: SectionNode; group: Group }>();
  for (const n of def.sectionGroups.header) out.set(n.id, { node: n, group: 'header' });
  for (const n of def.sectionGroups.footer) out.set(n.id, { node: n, group: 'footer' });
  for (const n of def.sections) out.set(n.id, { node: n, group: 'template' });
  return out;
}

function listOf(def: PageDefinition, group: Group): SectionNode[] {
  return group === 'template' ? def.sections : def.sectionGroups[group];
}

/** Apply only the fields that differ between `prev` and `next` onto `draft`. */
function mergeSection(draft: SectionNode, prev: SectionNode | undefined, next: SectionNode) {
  const merged: SectionNode = { ...draft, settings: { ...draft.settings } };
  const keys = new Set([...Object.keys(prev?.settings ?? {}), ...Object.keys(next.settings)]);
  for (const k of keys) {
    if (same(prev?.settings[k], next.settings[k])) continue;
    if (k in next.settings) merged.settings[k] = next.settings[k];
    else delete merged.settings[k];
  }
  for (const f of ['blocks', 'hidden', 'responsive'] as const) {
    if (same(prev?.[f], next[f])) continue;
    if (next[f] === undefined) delete merged[f];
    else (merged as Record<string, unknown>)[f] = next[f];
  }
  return merged;
}

export function rebaseDraftOntoLive(
  draft: PageDefinition,
  previousLive: PageDefinition,
  nextLive: PageDefinition
): PageDefinition {
  const prevIdx = index(previousLive);
  const nextIdx = index(nextLive);
  const out: PageDefinition = {
    ...draft,
    sectionGroups: {
      header: [...draft.sectionGroups.header],
      footer: [...draft.sectionGroups.footer],
    },
    sections: [...draft.sections],
    siteSettings: { ...draft.siteSettings },
  };

  // Sections the classic save changed, added or removed.
  const ids = new Set([...prevIdx.keys(), ...nextIdx.keys()]);
  for (const id of ids) {
    const prev = prevIdx.get(id);
    const next = nextIdx.get(id);
    if (same(prev?.node, next?.node) && prev?.group === next?.group) continue;
    const here = index(out).get(id);
    if (!next) {
      // Removed by the classic save.
      if (here) {
        const list = listOf(out, here.group);
        list.splice(list.indexOf(here.node), 1);
      }
    } else if (here) {
      const list = listOf(out, here.group);
      list[list.indexOf(here.node)] = mergeSection(here.node, prev?.node, next.node);
    } else if (!prev) {
      // Added by the classic save (the draft never had it).
      listOf(out, next.group).push(next.node);
    }
    // else: the draft deleted a section the classic save also edited: stays deleted.
  }

  // Order: only when the classic save reordered the template sections.
  const order = (def: PageDefinition) => def.sections.map(s => s.id);
  if (!same(order(previousLive), order(nextLive))) {
    const rank = new Map(order(nextLive).map((id, i) => [id, i]));
    const ranked = out.sections.filter(s => rank.has(s.id));
    const rest = out.sections.filter(s => !rank.has(s.id));
    ranked.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    out.sections = [...ranked, ...rest];
  }

  // Site settings the classic save changed.
  const keys = new Set([
    ...Object.keys(previousLive.siteSettings),
    ...Object.keys(nextLive.siteSettings),
  ]);
  for (const k of keys) {
    if (same(previousLive.siteSettings[k], nextLive.siteSettings[k])) continue;
    if (k in nextLive.siteSettings) out.siteSettings[k] = nextLive.siteSettings[k];
    else delete out.siteSettings[k];
  }

  if (!same(previousLive.legacy, nextLive.legacy)) {
    if (nextLive.legacy) out.legacy = nextLive.legacy;
    else delete out.legacy;
  }
  return out;
}
