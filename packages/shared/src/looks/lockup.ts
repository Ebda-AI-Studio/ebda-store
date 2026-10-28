import type { LookId, LookTemplate } from './types';

/**
 * The built-in typographic lockup (Ahmad 2026-10-25, plan 2026-10-25-templates-match-mockups G1): a store
 * WITHOUT an uploaded logo gets its name set the way the look's mock-up set it: the Arabic name in the
 * look's display face, and a letter-spaced Latin line beside or under it. A merchant logo always wins
 * (the header only reaches the lockup when there is no `logo`/`logoAr`). Values are the mock-ups' own
 * (apps/marketing/scripts/looks/*.py: qamar.py:36-37, dahab.py:54, souq.py:30-31 ...), in px at 1x.
 */
export interface Lockup {
  /** `stack` = Latin line under the Arabic name; `inline` = beside it. */
  layout: 'stack' | 'inline';
  /** Arabic (display face) size and weight. */
  size: number;
  weight: number;
  /** Latin line: size, weight, tracking in em, and which face. `none` drops the line (a name with no Latin form never gets one). */
  latinSize: number;
  latinWeight: number;
  latinTracking: number;
  latinFace: 'latin' | 'display' | 'body';
  /** Fixed Latin text (Workshop: `DAHAB · SILVER`); absent = the store's Latin name, uppercased. */
  latinText?: string;
  /** Colour roles (theme tokens): the Arabic name and the Latin line. */
  color: 'ink' | 'primary' | 'accent';
  latinColor: 'ink' | 'muted' | 'primary' | 'accent' | 'none';
}

const L = (l: Lockup): Lockup => l;

/** One per built look. */
export const LOCKUPS: Record<string, Lockup> = {
  'qamar.atelier': L({
    layout: 'stack',
    size: 36,
    weight: 700,
    latinSize: 13,
    latinWeight: 600,
    latinTracking: 0.34,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'muted',
  }),
  'qamar.lookbook': L({
    layout: 'stack',
    size: 38,
    weight: 400,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.3,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'muted',
  }),
  // the mock sets Vitrine at 72 px in a 142 px header block; a sticky phone header cannot carry that, so 56
  'qamar.vitrine': L({
    layout: 'stack',
    size: 56,
    weight: 700,
    latinSize: 13,
    latinWeight: 400,
    latinTracking: 0.4,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'muted',
  }),
  'souq.catalogue': L({
    layout: 'inline',
    size: 30,
    weight: 700,
    latinSize: 13,
    latinWeight: 600,
    latinTracking: 0.22,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'primary',
  }),
  'souq.night': L({
    layout: 'inline',
    size: 36,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.3,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'ink',
  }),
  'souq.showroom': L({
    layout: 'inline',
    size: 30,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.24,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'muted',
  }),
  'jasmine.apothecary': L({
    layout: 'stack',
    size: 38,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.3,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'ink',
  }),
  'jasmine.bloom': L({
    layout: 'inline',
    size: 36,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.24,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'ink',
  }),
  'jasmine.clinic': L({
    layout: 'inline',
    size: 30,
    weight: 600,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.26,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'muted',
  }),
  'lamma.table': L({
    layout: 'inline',
    size: 38,
    weight: 700,
    latinSize: 13,
    latinWeight: 600,
    latinTracking: 0.28,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'ink',
  }),
  'lamma.notebook': L({
    layout: 'inline',
    size: 36,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0.26,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'ink',
  }),
  'lamma.market': L({
    layout: 'inline',
    size: 36,
    weight: 700,
    latinSize: 13,
    latinWeight: 500,
    latinTracking: 0,
    latinFace: 'latin',
    color: 'accent',
    latinColor: 'none',
  }),
  'dahab.worn': L({
    layout: 'stack',
    size: 32,
    weight: 600,
    latinSize: 12,
    latinWeight: 400,
    latinTracking: 0.42,
    latinFace: 'latin',
    color: 'ink',
    latinColor: 'muted',
  }),
  'dahab.workshop': L({
    layout: 'stack',
    size: 36,
    weight: 600,
    latinSize: 12,
    latinWeight: 400,
    latinTracking: 0.34,
    latinFace: 'latin',
    latinText: 'DAHAB · SILVER',
    color: 'ink',
    latinColor: 'ink',
  }),
  'dahab.giftbox': L({
    layout: 'stack',
    size: 30,
    weight: 600,
    latinSize: 14,
    latinWeight: 400,
    latinTracking: 0.4,
    latinFace: 'latin',
    color: 'primary',
    latinColor: 'muted',
  }),
};

const DEFAULT_LOOK: Record<LookTemplate, LookId> = {
  qamar: 'qamar.atelier',
  souq: 'souq.catalogue',
  jasmine: 'jasmine.apothecary',
  lamma: 'lamma.table',
  dahab: 'dahab.worn',
};

/**
 * The lockup for a store: its look's, else its template's first look, else null (every other skin keeps its
 * own plain wordmark). The caller shows it only when the store has no uploaded logo.
 */
export function lockupFor(look?: string | null, template?: string | null): Lockup | null {
  if (look && LOCKUPS[look]) return LOCKUPS[look];
  const d = template ? DEFAULT_LOOK[template as LookTemplate] : undefined;
  return d ? (LOCKUPS[d] ?? null) : null;
}

/** The Latin line: the fixed text, else the store's Latin name uppercased; null when the name has no Latin form. */
export function lockupLatin(l: Lockup, name?: string | null): string | null {
  if (l.latinColor === 'none') return null;
  if (l.latinText) return l.latinText;
  const n = (name ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9 .&'-]*$/.test(n) ? n.toUpperCase() : null;
}
