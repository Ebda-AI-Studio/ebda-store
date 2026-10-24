'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { StoryStep } from '../lib/content';
import { STORY_FRAMES } from '../lib/story-frames';
import { Phone } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The pinned scroll story: the Dahab store assembling inside a phone, one frame per step
 * (name + logo, products, colours + photos, first order) and then the order notifications. Five beats, scrubbed
 * by scroll progress: --p (0..1) is the only moving part and CSS maps it to opacity/transform. The server renders
 * the beginning (frame 1, --p 0) so the first paint is where the scroll script leaves it; no-JS and reduced-motion
 * get the finished store in normal flow (the default CSS; the pin is behind `(scripting: enabled)`), as do crawlers.
 * The frames are screenshots of the Dahab look A fragment (scripts/story-frames/make.mjs).
 */
export function StoryScroll({
  title,
  steps,
  toasts,
  phoneLabel,
}: {
  title: string;
  steps: StoryStep[];
  toasts: { t: string; d: string }[];
  phoneLabel: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    // The pin and the scrub exist only where the CSS applies them: (scripting: enabled) + no-preference. Anywhere
    // else the page is the static finished store and --p must stay at its CSS default.
    if (
      !el ||
      reducedMotion() ||
      !window.matchMedia('(scripting: enabled) and (prefers-reduced-motion: no-preference)').matches
    )
      return;
    // Scroll-linked, not time-triggered: one number (--p, 0..1 across the pinned stretch) is the whole state;
    // CSS turns it into opacity/transform only. Geometry is measured once (and on resize), never per frame,
    // so a scroll tick does one write and no layout read.
    let top = 0;
    let span = 0;
    let last = -1;
    let raf = 0;
    const measure = () => {
      top = el.getBoundingClientRect().top + window.scrollY;
      span = el.offsetHeight - window.innerHeight;
    };
    const update = () => {
      raf = 0;
      const p = span > 0 ? Math.min(1, Math.max(0, (window.scrollY - top) / span)) : 1;
      if (Math.abs(p - last) < 0.0005) return;
      last = p;
      el.style.setProperty('--p', p.toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onResize = () => {
      measure();
      last = -1;
      onScroll();
    };
    // ---- desktop glide: a ~40-line rAF lerp on the wheel (Ahmad 2026-10-24). Fine pointer + hover only (never touch),
    // never under reduced motion (this effect already returned), and only while the story is on screen. Keyboard,
    // space bar, scrollbar drags and anchors stay native: any scroll we did not make re-syncs the target.
    const fine =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: fine) and (hover: hover)').matches;
    let target = window.scrollY;
    let cur = window.scrollY;
    let glideRaf = 0;
    let lastT = 0;
    const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
    const glide = (t: number) => {
      // a scroll we did not make (anchor, history, scrollbar) ends the glide instead of fighting it
      if (Math.abs(window.scrollY - cur) > 3) {
        glideRaf = 0;
        target = cur = window.scrollY;
        return;
      }
      const dt = lastT ? Math.min(64, t - lastT) : 16;
      lastT = t;
      cur += (target - cur) * (1 - Math.exp(-dt / 110));
      if (Math.abs(target - cur) < 0.4) cur = target;
      window.scrollTo({ top: cur, behavior: 'instant' }); // the page has scroll-behavior: smooth; the glide is the easing
      glideRaf = cur === target ? 0 : requestAnimationFrame(glide);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.defaultPrevented || e.deltaY === 0) return; // pinch-zoom / handled elsewhere
      // a nested vertical scroller (menu, dialog, textarea) keeps its own wheel
      for (let n = e.target as Element | null; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return;
      }
      e.preventDefault();
      const dy =
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * window.innerHeight
            : e.deltaY;
      if (!glideRaf) {
        cur = window.scrollY;
        target = cur;
        lastT = 0;
      }
      target = Math.min(maxScroll(), Math.max(0, target + dy));
      if (!glideRaf) glideRaf = requestAnimationFrame(glide);
    };
    const resync = () => {
      if (!glideRaf) {
        target = cur = window.scrollY;
      }
    };
    const stopGlide = () => {
      if (glideRaf) cancelAnimationFrame(glideRaf);
      glideRaf = 0;
      resync();
    };

    let listening = false;
    const io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1];
      if (e.isIntersecting && !listening) {
        listening = true;
        measure();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize);
        if (fine) {
          window.addEventListener('wheel', onWheel, { passive: false });
          window.addEventListener('scroll', resync, { passive: true });
          window.addEventListener('keydown', stopGlide);
          window.addEventListener('pointerdown', stopGlide);
        }
        onScroll();
      } else if (!e.isIntersecting && listening) {
        listening = false;
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('wheel', onWheel);
        window.removeEventListener('scroll', resync);
        window.removeEventListener('keydown', stopGlide);
        window.removeEventListener('pointerdown', stopGlide);
        stopGlide();
      }
    });
    // anything above the story that changes the page height (font swap, lazy image) moves `top`: watch the body too
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    ro?.observe(el);
    ro?.observe(document.body);
    void document.fonts?.ready.then(onResize);
    measure();
    update();
    io.observe(el);
    return () => {
      io.disconnect();
      ro?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('scroll', resync);
      window.removeEventListener('keydown', stopGlide);
      window.removeEventListener('pointerdown', stopGlide);
      if (glideRaf) cancelAnimationFrame(glideRaf);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section id="story" ref={ref} className="story" aria-labelledby="story-h">
      <div className="story-sticky">
        <div className="wrap story-grid">
          <div className="story-copy">
            <h2 id="story-h">{title}</h2>
            <ol className="story-steps">
              {steps.map((s, i) => (
                <li key={s.t} data-n={i + 1} style={{ '--k': i } as CSSProperties}>
                  <span className="story-step-t">{s.t}</span>
                  <span className="story-step-d">{s.d}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="story-stage" role="img" aria-label={phoneLabel}>
            <Phone className="story-phone">
              <div className="story-screen">
                {STORY_FRAMES.map((f, i) => (
                  <picture
                    className="story-frame"
                    data-f={i + 1}
                    key={f.name}
                    style={{ '--k': i } as CSSProperties}
                  >
                    <source type="image/avif" srcSet={`/devices/${f.name}.avif`} />
                    <img
                      src={`/devices/${f.name}.webp`}
                      width={f.w}
                      height={f.h}
                      alt=""
                      // frame 1 is the first thing the story paints and, on phones, sits in the first
                      // screen: it is the LCP element, so it loads eagerly at high priority
                      loading={i === 0 ? 'eager' : 'lazy'}
                      {...(i === 0 ? ({ fetchPriority: 'high' } as object) : {})}
                      decoding="async"
                    />
                  </picture>
                ))}
              </div>
              <ol className="story-toasts" aria-hidden="true">
                {toasts.map((n, i) => (
                  <li key={n.t} className="story-toast" style={{ '--i': i } as CSSProperties}>
                    <span className="toast-mark" />
                    <span>
                      <strong>{n.t}</strong>
                      <span>{n.d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Phone>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Adds `.in` once the element scrolls into view; the content is visible without it. */
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    // `armed` hides only what the reveal will draw in; without JS everything stays drawn.
    el.classList.add('armed');
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.classList.add('in');
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -15% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
