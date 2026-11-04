/**
 * Pure maths of the two-thumb price range (PriceRangeSlider). Kept apart from the component so
 * the keyboard and pointer rules are unit-tested without a DOM.
 */

export type Thumb = 'min' | 'max';

/** Snap `v` to the step grid anchored at `floor` and clamp it into [floor, ceil]. */
export function snap(v: number, floor: number, ceil: number, step: number): number {
  const s = step > 0 ? step : 1;
  const snapped = floor + Math.round((v - floor) / s) * s;
  return Math.min(ceil, Math.max(floor, snapped));
}

/** A 0..1 position along the track (already direction-corrected) to a snapped value. */
export function valueFromRatio(ratio: number, floor: number, ceil: number, step: number): number {
  const r = Math.min(1, Math.max(0, ratio));
  return snap(floor + r * (ceil - floor), floor, ceil, step);
}

/** Ratio of `v` along the track, 0..1 (a flat range reads as 0). */
export function ratioOf(v: number, floor: number, ceil: number): number {
  return ceil > floor ? Math.min(1, Math.max(0, (v - floor) / (ceil - floor))) : 0;
}

/**
 * Move one thumb to `value` without crossing the other (min <= max always). Returns the new
 * [min, max].
 */
export function moveThumb(thumb: Thumb, value: number, min: number, max: number): [number, number] {
  return thumb === 'min' ? [Math.min(value, max), max] : [min, Math.max(value, min)];
}

/**
 * The value a key press moves a thumb to, or null when the key is not a slider key. Visual
 * direction rules: in RTL the track runs right to left, so ArrowLeft INCREASES (it moves the
 * thumb toward the larger values); ArrowUp/ArrowDown always increase/decrease.
 */
export function valueForKey(
  key: string,
  current: number,
  o: { floor: number; ceil: number; step: number; rtl: boolean }
): number | null {
  const big = Math.max(o.step, (o.ceil - o.floor) / 10);
  const inc = o.rtl ? 'ArrowLeft' : 'ArrowRight';
  const dec = o.rtl ? 'ArrowRight' : 'ArrowLeft';
  let next: number;
  if (key === inc || key === 'ArrowUp') next = current + o.step;
  else if (key === dec || key === 'ArrowDown') next = current - o.step;
  else if (key === 'PageUp') next = current + big;
  else if (key === 'PageDown') next = current - big;
  else if (key === 'Home') next = o.floor;
  else if (key === 'End') next = o.ceil;
  else return null;
  return snap(next, o.floor, o.ceil, o.step);
}
