'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { StoryStep } from '../lib/content';
import { STORY_FRAMES } from '../lib/story-frames';
import { Phone } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The static story (the finished store in normal flow): what reduced-motion visitors and visitors without
 * JavaScript get. The server renders the JS state instead (step 0, phone tilted in, live layout) so the first
 * frame paints exactly where the scroll script will leave it; these overrides take over where that script
 * never runs. Used twice: a `<style media="(prefers-reduced-motion: reduce)">` and a `<noscript><style>`.
 */
const STORY_STATIC_CSS = `
.story[data-live]{height:auto!important;--p:1!important}
.story[data-live] .story-sticky{position:static!important;height:auto!important;display:block!important;overflow:visible!important;padding-block:clamp(72px,11vw,132px)!important}
.story[data-live] h2{font-size:clamp(1.9rem,5.2vw,3.4rem)!important;margin-bottom:24px!important}
.story[data-live] .story-steps{display:grid!important}
.story[data-live] .story-steps li{grid-area:auto!important;opacity:1!important;transform:none!important}
.story .story-phone{--w:min(300px,70vw)!important;transform:none!important}
.story .story-toast{transform:none!important;opacity:1!important}
`;

/**
 * The pinned scroll story: the Dahab store assembling inside a phone, one frame per step
 * (name + logo, products, colours + photos, first order) and then the order notifications. Five beats, scrubbed
 * by scroll progress: --p (0..1) is the only moving part and CSS maps it to opacity/transform. The server renders
 * the beginning (frame 1, --p 0) so the first paint is where the scroll script leaves it; no-JS and reduced-motion
 * get the finished store in normal flow (STORY_STATIC_CSS), as do crawlers.
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
    if (!el || reducedMotion()) return;
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
    let listening = false;
    const io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1];
      if (e.isIntersecting && !listening) {
        listening = true;
        measure();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize);
        onScroll();
      } else if (!e.isIntersecting && listening) {
        listening = false;
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
      }
    });
    // anything above the story that changes the page height (font swap, lazy image) moves `top`: watch the body too
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    ro?.observe(el);
    ro?.observe(document.body);
    void document.fonts?.ready.then(onResize);
    el.dataset.live = '1';
    measure();
    update();
    io.observe(el);
    return () => {
      io.disconnect();
      ro?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      id="story"
      ref={ref}
      className="story"
      data-live="1"
      style={{ '--p': 0 } as CSSProperties}
      aria-labelledby="story-h"
    >
      <style media="(prefers-reduced-motion: reduce)">{STORY_STATIC_CSS}</style>
      <noscript>
        <style>{STORY_STATIC_CSS}</style>
      </noscript>
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
