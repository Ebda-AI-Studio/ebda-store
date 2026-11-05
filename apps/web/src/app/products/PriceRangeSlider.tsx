'use client';

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { moveThumb, ratioOf, valueForKey, valueFromRatio, type Thumb } from './price-range';

/**
 * Two-thumb price range for the products filter (audit 2026-11-03 #9). Replaces two stacked
 * native range inputs (one 2012-looking control per bound, no formatted numbers, thumbs that could
 * not be told apart).
 *
 * - WAI-ARIA slider pattern: each thumb is `role="slider"` with `aria-valuemin/max/now` and an
 *   `aria-valuetext` in the shopper's money format ("1,200 ج.م"), focusable, full keyboard
 *   (arrows, PageUp/Down, Home/End; in RTL ArrowLeft raises the value, like the thumb moves).
 * - Pointer: pointer events with capture, so a mouse, a finger and a pen all drag; `touch-action:
 *   none` on the thumb stops the page scrolling under the drag. Each thumb has a 44 px hit area.
 * - RTL: positions use logical insets, and the pointer ratio is read from the track's own
 *   computed direction, so Arabic drags the right way without a prop.
 * - Every visible number comes from `format` (the store's currency + numerals).
 */
export function PriceRangeSlider(p: {
  floor: number;
  ceil: number;
  min: number;
  max: number;
  step?: number;
  onChange: (min: number, max: number) => void;
  /** MAJOR units to the shopper's formatted money string. */
  format: (v: number) => string;
  minLabel: string;
  maxLabel: string;
  idPrefix: string;
}) {
  const { floor, ceil, min, max, step = 1, onChange, format } = p;
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Thumb | null>(null);

  const isRtl = () =>
    trackRef.current ? getComputedStyle(trackRef.current).direction === 'rtl' : false;

  const commit = (thumb: Thumb, value: number) => {
    const [a, b] = moveThumb(thumb, value, min, max);
    if (a !== min || b !== max) onChange(a, b);
  };

  const fromPointer = (clientX: number): number | null => {
    const el = trackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    const x = isRtl() ? r.right - clientX : clientX - r.left;
    return valueFromRatio(x / r.width, floor, ceil, step);
  };

  const onDown = (thumb: Thumb) => (e: PointerEvent<HTMLDivElement>) => {
    drag.current = thumb;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
  };
  const onMove = (thumb: Thumb) => (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current !== thumb) return;
    const v = fromPointer(e.clientX);
    if (v !== null) commit(thumb, v);
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (thumb: Thumb) => (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = thumb === 'min' ? min : max;
    const next = valueForKey(e.key, cur, { floor, ceil, step, rtl: isRtl() });
    if (next === null) return;
    e.preventDefault();
    commit(thumb, next);
  };

  const a = ratioOf(min, floor, ceil) * 100;
  const b = ratioOf(max, floor, ceil) * 100;
  const thumbCls =
    "absolute top-1/2 z-10 h-6 w-6 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-primary bg-background shadow-sm outline-none transition-shadow before:absolute before:-inset-2.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing";

  const thumb = (which: Thumb, value: number, pos: number, label: string) => (
    <div
      id={`${p.idPrefix}-${which}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={floor}
      aria-valuemax={ceil}
      aria-valuenow={value}
      aria-valuetext={format(value)}
      aria-orientation="horizontal"
      data-thumb={which}
      className={thumbCls}
      style={{ insetInlineStart: `${pos}%`, marginInlineStart: '-12px' }}
      onPointerDown={onDown(which)}
      onPointerMove={onMove(which)}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey(which)}
    />
  );

  return (
    <div data-testid="price-range" className="px-3">
      <div className="mb-4 flex items-center justify-between gap-3 text-sm tabular-nums">
        <span
          data-testid="price-range-min"
          className="rounded-full bg-[hsl(var(--filter-fg)/0.08)] px-3 py-1 font-medium text-[hsl(var(--filter-fg))]"
        >
          {format(min)}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-[hsl(var(--filter-fg)/0.25)]" />
        <span
          data-testid="price-range-max"
          className="rounded-full bg-[hsl(var(--filter-fg)/0.08)] px-3 py-1 font-medium text-[hsl(var(--filter-fg))]"
        >
          {format(max)}
        </span>
      </div>
      <div ref={trackRef} className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[hsl(var(--filter-fg)/0.2)]" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
          style={{ insetInlineStart: `${a}%`, insetInlineEnd: `${100 - b}%` }}
        />
        {thumb('min', min, a, p.minLabel)}
        {thumb('max', max, b, p.maxLabel)}
      </div>
    </div>
  );
}
