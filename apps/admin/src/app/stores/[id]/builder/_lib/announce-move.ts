import type { PageDefinition, SectionNode } from '@ebda/shared';

export interface MoveAnnouncement {
  id: string;
  node: SectionNode;
  direction: 'up' | 'down';
  /** 1-based position after the move, and the list length. */
  pos: number;
  total: number;
}

const lists = (d: PageDefinition): SectionNode[][] => [
  d.sectionGroups.header,
  d.sections,
  d.sectionGroups.footer,
];

/**
 * If `next` is `prev` with exactly one section moved inside its own list, say which and which way.
 * Anything else (an edit, an add, a remove, a reload) is not a move and returns null.
 */
export function describeMove(
  prev: PageDefinition,
  next: PageDefinition,
  /** Moving A past its neighbour B equals moving B past A; the one the merchant acted on wins. */
  preferId?: string | null
): MoveAnnouncement | null {
  const a = lists(prev);
  const b = lists(next);
  for (let i = 0; i < a.length; i++) {
    const before = a[i].map(n => n.id);
    const after = b[i].map(n => n.id);
    if (before.length !== after.length || before.join() === after.join()) continue;
    if ([...before].sort().join() !== [...after].sort().join()) return null;
    // The moved id is the one whose removal makes the two orders equal.
    const rest = (xs: string[], id: string) => xs.filter(x => x !== id).join();
    const candidates = before.filter(id => rest(before, id) === rest(after, id));
    const id = candidates.includes(preferId ?? '') ? preferId! : candidates[0];
    if (id !== undefined) {
      const from = before.indexOf(id);
      const to = after.indexOf(id);
      return {
        id,
        node: b[i][to],
        direction: to < from ? 'up' : 'down',
        pos: to + 1,
        total: after.length,
      };
    }
  }
  return null;
}

export interface StructureAnnouncement {
  kind: 'added' | 'removed' | 'hidden' | 'shown';
  node: SectionNode;
  /** 1-based position (added) and the list length after the change. */
  pos: number;
  total: number;
}

/**
 * The other silent edits a screen-reader user makes from the tree or the canvas toolbar: a section
 * added, removed, hidden or shown (also what Undo / Redo of those does). Exactly one section may
 * differ; anything bigger (a reload, a restore, a look switch) is not announced as one change.
 */
export function describeStructure(
  prev: PageDefinition,
  next: PageDefinition
): StructureAnnouncement | null {
  const a = lists(prev);
  const b = lists(next);
  for (let i = 0; i < a.length; i++) {
    const before = a[i];
    const after = b[i];
    if (after.length === before.length + 1) {
      const known = new Set(before.map(n => n.id));
      const added = after.filter(n => !known.has(n.id));
      if (added.length === 1 && before.every(n => after.some(m => m.id === n.id)))
        return {
          kind: 'added',
          node: added[0],
          pos: after.indexOf(added[0]) + 1,
          total: after.length,
        };
    } else if (after.length === before.length - 1) {
      const kept = new Set(after.map(n => n.id));
      const gone = before.filter(n => !kept.has(n.id));
      if (gone.length === 1 && after.every(n => before.some(m => m.id === n.id)))
        return {
          kind: 'removed',
          node: gone[0],
          pos: before.indexOf(gone[0]) + 1,
          total: after.length,
        };
    } else if (after.length === before.length) {
      const flipped = after.filter(
        (n, k) => before[k]?.id === n.id && !!before[k].hidden !== !!n.hidden
      );
      if (flipped.length === 1 && before.map(n => n.id).join() === after.map(n => n.id).join())
        return {
          kind: flipped[0].hidden ? 'hidden' : 'shown',
          node: flipped[0],
          pos: after.indexOf(flipped[0]) + 1,
          total: after.length,
        };
    }
  }
  return null;
}
