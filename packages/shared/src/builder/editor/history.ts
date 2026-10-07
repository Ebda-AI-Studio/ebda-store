/**
 * Undo / redo for the editor (visual builder Phase 2). A bounded history of
 * whole documents (structural sharing keeps that cheap), separate from saved
 * revisions:
 *   - `push` records a new present; the redo stack is cleared;
 *   - edits carrying the same `coalesceKey` within `coalesceMs` replace the
 *     present instead of stacking (typing one word is one undo step);
 *   - at most `cap` past states are kept (the oldest drops off).
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_CAP = 100;
export const COALESCE_MS = 800;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

export function pushHistory<T>(
  h: History<T>,
  next: T,
  opts: { coalesceKey?: string; now?: number; cap?: number; coalesceMs?: number } = {}
): History<T> {
  if (next === h.present) return h;
  const now = opts.now ?? Date.now();
  const cap = opts.cap ?? HISTORY_CAP;
  const window = opts.coalesceMs ?? COALESCE_MS;
  const coalesce =
    opts.coalesceKey !== undefined &&
    opts.coalesceKey === h.lastKey &&
    now - h.lastAt <= window &&
    h.past.length > 0;
  if (coalesce) return { ...h, present: next, future: [], lastAt: now };
  const past = [...h.past, h.present];
  if (past.length > cap) past.splice(0, past.length - cap);
  return { past, present: next, future: [], lastKey: opts.coalesceKey ?? null, lastAt: now };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const past = h.past.slice(0, -1);
  return {
    past,
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...future] = h.future;
  return { past: [...h.past, h.present], present: next, future, lastKey: null, lastAt: 0 };
}

/** Replace the present WITHOUT an undo step (e.g. the server's copy after a reload). */
export function resetHistory<T>(present: T): History<T> {
  return createHistory(present);
}
