'use client';

/**
 * A side pane of the editor that the merchant can resize by dragging its inner edge (Ahmad 2026-11-15, plan
 * decision 1). Owns the aside AND its width state, so a drag re-renders only this wrapper: the children are the
 * same elements the parent already built (React bails out), and the canvas iframe is a sibling that is never
 * re-keyed, so a resize never reloads it. Pointer moves are coalesced to one DOM write per frame
 * (`createFrameCoalescer`); the width is committed to state, and to localStorage, on release.
 *
 * Direction is logical: the handle sits on the pane's inner edge (`-end-1` for the start pane, `-start-1` for the
 * end pane), growth follows the reading direction, so everything mirrors in Arabic.
 * Accessibility: role=separator, aria-orientation=vertical, aria-valuenow/min/max, Left/Right = 16px,
 * Home/End = min/max, double click = default. Below `lg` the pane is a drawer and the handle is hidden.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createFrameCoalescer } from '../_lib/frame-coalescer';
import {
  CANVAS_MIN,
  clampPaneWidth,
  clearPaneWidth,
  readPaneWidth,
  writePaneWidth,
} from '../_lib/pane-width';

const STEP = 16;

export function ResizablePane({
  side,
  storageKey,
  def,
  min,
  max,
  label,
  className,
  asideRef,
  children,
  ...aside
}: {
  /** Which edge of the editor the pane sits on. */
  side: 'start' | 'end';
  storageKey: string;
  def: number;
  min: number;
  max: number;
  /** Accessible name of the handle ("Resize the left panel"). */
  label: string;
  className: string;
  asideRef?: Ref<HTMLElement>;
  children: ReactNode;
  id?: string;
  tabIndex?: number;
  'aria-label'?: string;
}) {
  const own = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(def);
  const dragging = useRef<{ x: number; w: number } | null>(null);

  const setRefs = (el: HTMLElement | null) => {
    own.current = el;
    if (typeof asideRef === 'function') asideRef(el);
    else if (asideRef) (asideRef as { current: HTMLElement | null }).current = el;
  };

  const rtl = () => own.current?.closest('[dir]')?.getAttribute('dir') === 'rtl';
  /** +1 when moving the pointer toward the right edge of the screen makes the pane wider. */
  const growSign = () => ((side === 'start') === !rtl() ? 1 : -1);

  /** Room left for this pane: the container minus the other panes minus the canvas minimum. */
  const room = useCallback((): number | undefined => {
    const host = own.current?.parentElement;
    if (!host || host.clientWidth === 0) return undefined;
    let others = 0;
    host.querySelectorAll<HTMLElement>(':scope > [data-resizable-pane]').forEach(p => {
      if (p !== own.current) others += p.offsetWidth;
    });
    return host.clientWidth - others - CANVAS_MIN;
  }, []);
  const clamp = useCallback((w: number) => clampPaneWidth(w, min, max, room()), [min, max, room]);

  useEffect(() => {
    const saved = readPaneWidth(storageKey);
    if (saved !== null) setWidth(clampPaneWidth(saved, min, max, undefined));
  }, [storageKey, min, max]);

  // A narrower window never lets the panes squeeze the canvas below its minimum.
  useEffect(() => {
    // Paint-only: the saved/preferred width stays in state, so widening the window restores it.
    const onResize = () => own.current?.style.setProperty('--pane-w', `${clamp(width)}px`);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp, width]);

  const paint = useRef(
    createFrameCoalescer<number>(w => own.current?.style.setProperty('--pane-w', `${w}px`))
  );
  useEffect(() => {
    const c = paint.current;
    return () => c.cancel();
  }, []);

  const commit = (w: number) => {
    const next = clamp(w);
    setWidth(next);
    writePaneWidth(storageKey, next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = { x: e.clientX, w: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (!d) return;
    paint.current.schedule(clamp(d.w + (e.clientX - d.x) * growSign()));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    paint.current.cancel();
    commit(d.w + (e.clientX - d.x) * growSign());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = growSign();
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = width + STEP * grow;
    else if (e.key === 'ArrowLeft') next = width - STEP * grow;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };

  return (
    <aside
      {...aside}
      ref={setRefs}
      data-resizable-pane={side}
      style={{ '--pane-w': `${width}px` } as CSSProperties}
      className={`${className} lg:w-[var(--pane-w)] lg:flex-none`}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        data-testid={`pane-resizer-${side}`}
        data-side={side}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragging.current = null;
          paint.current.cancel();
          own.current?.style.setProperty('--pane-w', `${width}px`);
        }}
        onDoubleClick={() => {
          setWidth(clamp(def));
          clearPaneWidth(storageKey);
        }}
        onKeyDown={onKeyDown}
        className={`group absolute inset-y-0 z-10 hidden w-2 cursor-col-resize touch-none outline-none lg:block ${
          side === 'start' ? '-end-1' : '-start-1'
        }`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-primary/50 group-focus-visible:bg-primary group-active:bg-primary motion-reduce:transition-none"
        />
      </div>
    </aside>
  );
}
