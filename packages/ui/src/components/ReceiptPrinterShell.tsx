'use client';

/**
 * The receipt printer, as hardware: a printer body with a screen, a slot, and
 * a white thermal receipt that feeds DOWN out of it (torn edge last). Shared by
 * the storefront order confirmation and Ebda's own billing receipt, so the
 * animation exists once. Content (what the screen says, what the paper prints)
 * is the caller's.
 *
 * Motion: one transform keyframe (1600ms ease-out-quint, 250ms after `feedKey`
 * appears), once per key per tab (sessionStorage), none at all under
 * prefers-reduced-motion. The paper keeps its full height in layout during the
 * feed, so nothing below jumps when it ends, and it is real text throughout.
 *
 * Colours come from CSS variables, defaulting to the storefront's store tokens
 * (`--foreground` / `--background` as HSL triplets); Ebda billing overrides
 * `--rp-housing`, `--rp-screen-bg`, `--rp-screen-fg`, `--rp-slit` via `style`.
 * Paper and its ink are fixed: thermal paper is white with near-black ink.
 * Styles are an inline <style> (no CSS-module build step in a source package);
 * class names are `rp-` prefixed.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';
/** Mirror `.rp-feeding` below. */
const FEED_DELAY_MS = 250;
const FEED_MS = 1600;

/** Feed only on the first view of this key in this tab, and never under reduced motion. */
function shouldFeed(storageKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.(REDUCED).matches) return false;
  } catch {
    /* no matchMedia: feed */
  }
  try {
    return window.sessionStorage.getItem(storageKey) === null;
  } catch {
    return true;
  }
}

export interface ReceiptPrinterShellProps {
  /** Identity of what is being printed; null = nothing yet (empty slot, no paper). */
  feedKey: string | null;
  /** sessionStorage prefix for the once-per-tab rule. */
  storagePrefix?: string;
  /** The printer's screen. `feedDone` is false while paper is feeding. */
  screen: (state: { feedDone: boolean }) => ReactNode;
  /** The printed receipt (inside the paper `<article>`). */
  children: ReactNode;
  paperClassName?: string;
  /** Height the empty slot holds while loading (tailwind class), e.g. `min-h-[32rem]`. */
  loadingReserve?: string;
  paperTestId?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function ReceiptPrinterShell({
  feedKey,
  storagePrefix = 'receipt-printed:',
  screen,
  children,
  paperClassName = '',
  loadingReserve = '',
  paperTestId = 'receipt-paper',
  ariaLabel,
  className = 'mx-auto mt-8 w-full max-w-[24rem] text-start',
  style,
}: ReceiptPrinterShellProps) {
  // Decided ONCE per key, before the first paint that shows the paper:
  // deciding in an effect would flash the finished receipt, then snap it up.
  const decision = useRef<{ id: string; feed: boolean } | null>(null);
  if (feedKey && decision.current?.id !== feedKey) {
    decision.current = { id: feedKey, feed: shouldFeed(storagePrefix + feedKey) };
  }
  const feed = !!feedKey && decision.current?.feed === true;
  const [fedId, setFedId] = useState<string | null>(null);
  const feedDone = !feed || fedId === feedKey;

  useEffect(() => {
    if (!feedKey || !feed) return;
    try {
      window.sessionStorage.setItem(storagePrefix + feedKey, '1');
    } catch {
      /* storage blocked: the receipt simply prints again next time */
    }
    // Backstop: if `animationend` never arrives (cancelled or suppressed), the
    // screen must not stay on "printing" forever.
    const timer = window.setTimeout(() => setFedId(feedKey), FEED_DELAY_MS + FEED_MS + 400);
    return () => window.clearTimeout(timer);
  }, [feedKey, feed, storagePrefix]);

  return (
    <section className={className} style={style} aria-label={ariaLabel}>
      <style>{CSS}</style>
      <div className="rp-housing relative z-10 p-1.5 shadow-lg">
        <div className="rp-screen px-4 pb-3.5 pt-4">{screen({ feedDone })}</div>
        <div className="rp-slit mx-2.5 mb-0.5 mt-2 h-1.5 rounded-[var(--radius)]" />
      </div>
      {/* The slot is empty but holds a typical receipt's height while loading; once the key
          is known the paper is in the flow at its final height before the feed starts. */}
      <div className={`rp-window mx-4 sm:mx-5 ${feedKey ? '' : loadingReserve}`}>
        {feedKey && (
          <div
            className={`rp-feeder ${feed && !feedDone ? 'rp-feeding' : ''}`}
            data-feeding={feed && !feedDone ? 'true' : undefined}
            data-testid={paperTestId}
            onAnimationEnd={e => {
              if (e.target === e.currentTarget) setFedId(feedKey);
            }}
          >
            <article className={`rp-paper ${paperClassName}`}>{children}</article>
          </div>
        )}
      </div>
    </section>
  );
}

const CSS = `
.rp-housing{background:var(--rp-housing,color-mix(in oklab,hsl(var(--foreground)) 84%,hsl(var(--background))));border-radius:var(--radius)}
.rp-screen{background:var(--rp-screen-bg,hsl(var(--foreground)));color:var(--rp-screen-fg,hsl(var(--background)));border-radius:max(0px,calc(var(--radius) - 4px))}
.rp-slit{background:var(--rp-slit,color-mix(in oklab,hsl(var(--foreground)) 30%,#000));box-shadow:inset 0 1px 2px rgb(0 0 0/.7)}
.rp-window{position:relative;overflow:hidden;padding-bottom:14px}
.rp-window::before{content:'';position:absolute;inset-inline:0;top:0;height:8px;z-index:1;pointer-events:none;background:linear-gradient(rgb(0 0 0/.14),rgb(0 0 0/0))}
.rp-feeder{filter:drop-shadow(0 0 .5px rgb(0 0 0/.18)) drop-shadow(0 4px 8px rgb(0 0 0/.08))}
.rp-feeding{animation:rp-feed 1600ms cubic-bezier(.22,1,.36,1) 250ms both;will-change:transform}
@keyframes rp-feed{from{transform:translateY(-100%)}to{transform:translateY(0)}}
.rp-paper{background:#fff;color:#141414;padding-bottom:8px;-webkit-mask-image:linear-gradient(#000,#000),conic-gradient(from -45deg at 50% 100%,#000 90deg,#0000 0);mask-image:linear-gradient(#000,#000),conic-gradient(from -45deg at 50% 100%,#000 90deg,#0000 0);-webkit-mask-size:100% calc(100% - 8px),16px 8px;mask-size:100% calc(100% - 8px),16px 8px;-webkit-mask-position:top,bottom center;mask-position:top,bottom center;-webkit-mask-repeat:no-repeat,repeat-x;mask-repeat:no-repeat,repeat-x}
@media (prefers-reduced-motion:reduce){.rp-feeding{animation:none}}
`;
