'use client';

import { AutoplayToggle } from './AutoplayToggle';
import { useState, useEffect, useCallback, useRef } from 'react';
import { IMAGE_STANDARDS } from '@ebda/shared';
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

// Single source of truth: mobile aspect ratio derived from the shared
// image standard so the storefront render and the admin upload hint
// can never drift from each other. If IMAGE_STANDARDS.heroMobile changes,
// both the render and the hint update automatically.
const HERO_MOBILE = IMAGE_STANDARDS.heroMobile;

export function HeroSlider({
  slides,
  autoplayMs = 5000,
  isRtl,
  pack,
  presentation = 'full-bleed',
  frameLine,
  textAnchor,
  headingZone,
  urlPrefix,
}: HeroSliderProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const pausedRef = useRef(false);
  // Rule (e) (W4): a visible pause toggle, beside the hover / focus / hidden-tab holds.
  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);
  userPausedRef.current = userPaused;
  const [canAutoplay, setCanAutoplay] = useState(false);
  useEffect(() => {
    setCanAutoplay(
      autoplayMs > 0 &&
        slides.length > 1 &&
        !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }, [autoplayMs, slides.length]);
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
      if (pausedRef.current || userPausedRef.current || document.hidden) return;
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
        frameLine={frameLine}
        textAnchor={textAnchor}
        headingZone={headingZone}
        urlPrefix={urlPrefix}
      />
    );
  }

  // Mobile hero aspect: derived from IMAGE_STANDARDS.heroMobile, supplied as a
  // CSS custom property consumed by `aspect-[var(--hero-m-aspect)]`. Desktop
  // uses the canonical sm:aspect-[1920/700] (2.74:1) full-bleed. See the JSX
  // comment + HeroBanner.tsx for why this is NOT an inline aspectRatio (inline
  // styles beat responsive classes — the desktop override silently never won).
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

  const anchoredBelow = textAnchor === 'bottom-start';
  // Pagination dots. With the copy anchored bottom-start they sit in the track's inline-end corner.
  const dots = (
    <div
      // Copy anchored bottom-start: the dots move to the inline-end corner, off the button.
      className={
        textAnchor === 'bottom-start'
          ? 'absolute bottom-4 end-4 z-20 flex items-center gap-2'
          : 'absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2'
      }
      role="tablist"
      aria-label={isRtl ? 'شرائح البانر الرئيسي' : 'Hero slides'}
    >
      {slides.map((_, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={
            isRtl ? `الشريحة ${i + 1} من ${slides.length}` : `Slide ${i + 1} of ${slides.length}`
          }
          onClick={() => goTo(i)}
          className={`h-2 rounded-full transition-[width,background-color,box-shadow] ${
            i === activeIndex ? 'w-6 bg-white shadow-md' : 'w-2 bg-white/60 hover:bg-white/80'
          }`}
        />
      ))}
    </div>
  );

  return (
    <section
      className="relative w-full overflow-hidden"
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
      onFocus={() => (pausedRef.current = true)}
      onBlur={() => (pausedRef.current = false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      aria-roledescription="carousel"
    >
      {/* Mobile: aspect-[var(--hero-m-aspect)] (value from style) + 45vh ceiling.
          Desktop (sm:): sm:aspect-[1920/700] overrides it via the breakpoint — both
          are classes, so the later sm: utility wins (an inline aspectRatio would NOT
          be overridable). overflow-hidden on the parent clips both. */}
      <div
        className="relative aspect-[var(--hero-m-aspect)] max-h-[45vh] overflow-hidden sm:aspect-[1920/700] sm:max-h-none"
        style={
          {
            '--hero-m-aspect': `${HERO_MOBILE.width} / ${HERO_MOBILE.height}`,
          } as React.CSSProperties
        }
      >
        {slides.map((slide, i) => (
          <div
            key={i}
            className={`absolute inset-0 transition-opacity duration-[var(--duration-slower)] ${
              i === activeIndex ? 'opacity-100 z-10' : 'opacity-0 z-0'
            }`}
            aria-hidden={i !== activeIndex}
            aria-roledescription="slide"
            aria-label={
              isRtl ? `الشريحة ${i + 1} من ${slides.length}` : `Slide ${i + 1} of ${slides.length}`
            }
          >
            {/* Priority on slide 0 only — that's the LCP image. The rest
                lazy-load so we don't preload 6 banners on every page view. */}
            <HeroBanner
              {...slide}
              isRtl={isRtl}
              pack={pack}
              priority={i === 0}
              active={i === activeIndex}
              presentation={presentation}
              frameLine={frameLine}
              textAnchor={textAnchor}
              inSlider
              headingZone={headingZone}
              urlPrefix={urlPrefix}
            />
          </div>
        ))}
        {anchoredBelow && dots}
        {canAutoplay && (
          <AutoplayToggle
            paused={userPaused}
            onToggle={() => setUserPaused(p => !p)}
            labels={
              isRtl
                ? { pause: 'إيقاف العرض التلقائي', play: 'تشغيل العرض التلقائي' }
                : { pause: 'Pause the slideshow', play: 'Play the slideshow' }
            }
            className="absolute top-3 end-3"
          />
        )}
      </div>
      {!anchoredBelow && dots}
      {/* W2a fix round 1 (I-1): below xl the active slide's copy sits under the track as page
          text, so the slides keep >= 60% of the photo clear on phones and tablets too. */}
      {anchoredBelow && slides[activeIndex] && (
        <HeroBanner
          {...slides[activeIndex]}
          isRtl={isRtl}
          pack={pack}
          textAnchor={textAnchor}
          inSlider
          copyOnly
          headingZone={headingZone}
          urlPrefix={urlPrefix}
        />
      )}
    </section>
  );
}
