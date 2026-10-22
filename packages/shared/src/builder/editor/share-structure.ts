import type { PageDefinition, SectionNode } from '../schema';

/**
 * A `render` message arrives as a freshly parsed document, so no object keeps its identity. This
 * gives every node that did not change (deep-equal by id) its previous object back, so a renderer
 * memoized by node identity re-renders only the nodes an edit touched. Pure; never mutates either
 * document.
 */
export function shareStructure(prev: PageDefinition | null, next: PageDefinition): PageDefinition {
  if (!prev) return next;
  const share = (before: SectionNode[], after: SectionNode[]): SectionNode[] => {
    const old = new Map(before.map(n => [n.id, n]));
    let same = before.length === after.length;
    const out = after.map((n, i) => {
      const o = old.get(n.id);
      const keep = o !== undefined && JSON.stringify(o) === JSON.stringify(n) ? o : n;
      if (keep !== before[i]) same = false;
      return keep;
    });
    return same ? before : out;
  };
  const sections = share(prev.sections, next.sections);
  const header = share(prev.sectionGroups.header, next.sectionGroups.header);
  const footer = share(prev.sectionGroups.footer, next.sectionGroups.footer);
  const { sections: _s, sectionGroups: _g, ...rest } = next;
  const { sections: _ps, sectionGroups: _pg, ...prevRest } = prev;
  const restSame = JSON.stringify(rest) === JSON.stringify(prevRest);
  if (
    restSame &&
    sections === prev.sections &&
    header === prev.sectionGroups.header &&
    footer === prev.sectionGroups.footer
  )
    return prev;
  return {
    ...next,
    sections,
    sectionGroups: { ...next.sectionGroups, header, footer },
  };
}
