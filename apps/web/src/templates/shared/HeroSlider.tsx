'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { HeroBanner } from './HeroBanner';
import type { HeroSliderProps } from '../types';

/**
 * Autoplay hero slider — pagination dots, no arrows (per Pecannbee spec).
 * One slide is rendered as a HeroBanner so the markup, sizing, and
 * accessibility props match the single-banner mode exactly.
 *
 * Autoplay pauses while the user holds focus on a dot and on tab visibility
 * change so we don't burn the LCP image budget when the page is hidden.
 */
export function HeroSlider({
  slides,
  autoplayMs = 5000,
  isRtl,
  pack,
  presentation = 'full-bleed',
  headingZone,
}: HeroSliderProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const pausedRef = useRef(false);
  const touchStartXRef = useRef<number | null>(null);

  const goTo = useCallback(
    (index: number) => {
      if (slides.length === 0) return;
      const next = ((index % slides.length) + slides.length) % slides.length;
      setActiveIndex(next);
    },
    [slides.length]
  );

  useEffect(() => {
    if (autoplayMs <= 0 || slides.length <= 1) return;

    // Respect prefers-reduced-motion — users who disabled motion at the OS
    // level shouldn't get an autoplay carousel. They can still navigate via
    // the pagination dots.
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduceQuery.matches) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (pausedRef.current || document.hidden) return;
      setActiveIndex(i => (i + 1) % slides.length);
    };

    intervalId = setInterval(tick, autoplayMs);
    const onVisibility = () => {
      // Reset the interval timer on tab return so we don't fire immediately
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(tick, autoplayMs);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [autoplayMs, slides.length]);

  if (slides.length === 0) return null;
  if (slides.length === 1) {
    return (
      <HeroBanner
        {...slides[0]}
        isRtl={isRtl}
        pack={pack}
        priority
        presentation={presentation}
        headingZone={headingZone}
      />
    );
  }

  // Mobile hero is always LANDSCAPE — Ahmad 2026-05-18 directive (see
  // HeroBanner.tsx for the full rationale). Carousel container aspect
  // matches the canonical 1920×700 desktop hero on both breakpoints.
  // Dedicated mobile images are still honored as sources but render in
  // the same landscape container.
  const mobileAspectClass = 'aspect-[1920/700]';

  // Touch swipe — 40px threshold, RTL-aware direction.
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartXRef.current;
    touchStartXRef.current = null;
    if (start === null) return;
    const end = e.changedTouches[0]?.clientX;
    if (end === undefined) return;
    const dx = end - start;
    if (Math.abs(dx) < 40) return;
    // In RTL, swiping left should go backwards (next slide is at lower index).
    const dir = dx > 0 ? -1 : 1;
    goTo(activeIndex + (isRtl ? -dir : dir));
  };

  return (
    <section
      className="relative w-full"
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
      onFocus={() => (pausedRef.current = true)}
      onBlur={() => (pausedRef.current = false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      aria-roledescription="carousel"
    >
      <div className={`relative ${mobileAspectClass} sm:aspect-[1920/700]`}>
        {slides.map((slide, i) => (
          <div
            key={i}
            className={`absolute inset-0 transition-opacity duration-700 ${
              i === activeIndex ? 'opacity-100 z-10' : 'opacity-0 z-0'
            }`}
            aria-hidden={i !== activeIndex}
            aria-roledescription="slide"
            aria-label={`Slide ${i + 1} of ${slides.length}`}
          >
            {/* Priority on slide 0 only — that's the LCP image. The rest
                lazy-load so we don't preload 6 banners on every page view. */}
            <HeroBanner
              {...slide}
              isRtl={isRtl}
              pack={pack}
              priority={i === 0}
              presentation={presentation}
              headingZone={headingZone}
            />
          </div>
        ))}
      </div>

      {/* Pagination dots */}
      <div
        className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2"
        role="tablist"
        aria-label="Hero slides"
      >
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === activeIndex}
            aria-label={`Slide ${i + 1} of ${slides.length}`}
            onClick={() => goTo(i)}
            className={`h-2 rounded-full transition-all ${
              i === activeIndex ? 'w-6 bg-white shadow-md' : 'w-2 bg-white/60 hover:bg-white/80'
            }`}
          />
        ))}
      </div>
    </section>
  );
}
