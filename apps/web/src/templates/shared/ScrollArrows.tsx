'use client';

/**
 * Prev/next buttons for a horizontal scroll row (a11y P2-13): the category strip and
 * shop-the-look rows had none, so a mouse without a trackpad could not reach the tail.
 * Same anatomy as ProductCarousel's pair: 44px, named, hidden below `sm` where touch
 * scrolling is the affordance, inert (disabled and invisible) at the row's edges.
 * The parent must be `relative`.
 */
import { useEffect, useState, type RefObject } from 'react';
import { smoothScrollLeftBy } from '@/lib/smooth-scroll';

const BTN =
  'absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-foreground/10 shadow-[0_10px_24px_-12px_hsl(var(--foreground)/0.18)] hover:bg-muted text-foreground transition-[opacity,background-color] duration-[var(--duration-base)] ease-[var(--ease-out)] cursor-pointer disabled:pointer-events-none disabled:opacity-0';

export function ScrollArrows({
  scrollRef,
  isRtl,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  isRtl: boolean;
}) {
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      // RTL flips the sign of scrollLeft in some engines; abs() normalises.
      const pos = Math.abs(el.scrollLeft);
      setCanPrev(pos > 4);
      setCanNext(pos < max - 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [scrollRef]);

  const step = (direction: 'prev' | 'next') => {
    const el = scrollRef.current;
    if (!el) return;
    const first = el.querySelector('li');
    const by = first ? first.clientWidth + 24 : el.clientWidth * 0.45;
    smoothScrollLeftBy(el, (direction === 'next' ? 1 : -1) * (isRtl ? -1 : 1) * by);
  };

  // One mirroring utility (R-08): the path points inline-start or -end in LTR and flips in RTL.
  const icon = (d: string) => (
    <svg
      className="h-5 w-5 rtl:-scale-x-100"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );

  return (
    <>
      <button
        type="button"
        data-scroll-prev
        disabled={!canPrev}
        aria-label={isRtl ? 'السابق' : 'Previous'}
        onClick={() => step('prev')}
        className={`${BTN} start-2`}
      >
        {icon('M15 19l-7-7 7-7')}
      </button>
      <button
        type="button"
        data-scroll-next
        disabled={!canNext}
        aria-label={isRtl ? 'التالي' : 'Next'}
        onClick={() => step('next')}
        className={`${BTN} end-2`}
      >
        {icon('M9 5l7 7-7 7')}
      </button>
    </>
  );
}
