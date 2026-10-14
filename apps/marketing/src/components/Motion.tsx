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
.story[data-live]{height:auto!important}
.story[data-live] .story-sticky{position:static!important;height:auto!important;display:block!important;overflow:visible!important;padding-block:clamp(72px,11vw,132px)!important}
.story[data-live] h2{font-size:clamp(1.9rem,5.2vw,3.4rem)!important;margin-bottom:24px!important}
.story[data-live] .story-steps li{display:grid!important}
.story .story-phone{--w:min(300px,70vw)!important;transform:none!important}
.story .story-frame[data-f='1']{opacity:0!important}
.story .story-frame[data-f='4']{opacity:1!important}
.story .story-toast{transform:none!important;opacity:1!important}
.story[data-live] .story-steps li .story-step-t{color:var(--fg)!important}
.story[data-live] .story-steps li::before{color:var(--accent-text)!important}
`;

/**
 * The pinned scroll story: the Dahab store assembling inside a phone, one frame per step
 * (name + logo, products, colours + photos, first order). The server renders the finished state
 * (step 4: the last frame plus the notifications) so no-JS, reduced-motion and crawlers see the
 * whole store; on scroll we drive --p and data-step, and CSS crossfades the frame for that step.
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
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      const step = p < 0.12 ? 0 : p < 0.3 ? 1 : p < 0.5 ? 2 : p < 0.78 ? 3 : 4;
      el.style.setProperty('--p', p.toFixed(4));
      el.style.setProperty('--in', Math.min(1, p / 0.12).toFixed(4));
      el.dataset.step = String(step);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    let listening = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !listening) {
        listening = true;
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        onScroll();
      } else if (!e.isIntersecting && listening) {
        listening = false;
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      }
    });
    el.dataset.live = '1';
    update();
    io.observe(el);
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      id="story"
      ref={ref}
      className="story"
      data-live="1"
      data-step="0"
      style={{ '--p': 0, '--in': 0 } as CSSProperties}
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
                <li key={s.t} data-n={i + 1}>
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
                  <picture className="story-frame" data-f={i + 1} key={f.name}>
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
