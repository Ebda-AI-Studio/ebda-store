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
