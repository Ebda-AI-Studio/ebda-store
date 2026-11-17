/** Pane widths: bounds, clamping and the per-user, per-pane memory (localStorage, always try/catch). */

/** The preview never collapses below this, whatever the panes ask for. */
export const CANVAS_MIN = 400;

export const PANE_BOUNDS = {
  start: { def: 320, min: 280, max: 480 },
  end: { def: 360, min: 300, max: 520 },
} as const;

const key = (name: string) => `ebda.builder.pane.${name}`;

/**
 * Clamp to [min, max]; `room` (container minus the other pane minus the canvas minimum) can lower the ceiling,
 * but never below `min`: the minimum wins, so a pane is always usable.
 */
export function clampPaneWidth(w: number, min: number, max: number, room?: number): number {
  const ceiling = room === undefined ? max : Math.min(max, room);
  return Math.round(Math.max(min, Math.min(w, ceiling)));
}

export function readPaneWidth(name: string): number | null {
  try {
    const raw = window.localStorage.getItem(key(name));
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writePaneWidth(name: string, w: number): void {
  try {
    window.localStorage.setItem(key(name), String(w));
  } catch {
    /* storage blocked: the width still applies for this session */
  }
}

export function clearPaneWidth(name: string): void {
  try {
    window.localStorage.removeItem(key(name));
  } catch {
    /* nothing to clear */
  }
}
