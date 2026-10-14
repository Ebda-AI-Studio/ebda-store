'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { DEVICE_SHOTS, STORY_STRIP } from '../lib/device-shots';
import { Phone } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How far the full-page strip can scroll inside the phone, as % of the strip's height. */
const PHONE_VIEWPORT = { w: 390, h: 844 };
const STRIP_MAX_PCT =
  (1 - PHONE_VIEWPORT.h / PHONE_VIEWPORT.w / (STORY_STRIP.h / STORY_STRIP.w)) * 100;

/**
 * The pinned scroll story. The server renders the finished state (step 4) so no-JS,
 * reduced-motion and crawlers see the whole store; on scroll we drive --p and data-step.
 */
export function StoryScroll({
  title,
  steps,
  toasts,
  phoneLabel,
}: {
  title: string;
  steps: string[];
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
      // Steps 1-3: the real store scrolls inside the phone, from the hero down to its products.
      el.style.setProperty(
        '--scroll',
        (Math.min(1, Math.max(0, (p - 0.12) / 0.62)) * 0.66).toFixed(4)
      );
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
    <section id="story" ref={ref} className="story" data-step="4" aria-labelledby="story-h">
      <div className="story-sticky">
        <div className="wrap story-grid">
          <div className="story-copy">
            <h2 id="story-h">{title}</h2>
            <ol className="story-steps">
              {steps.map((s, i) => (
                <li key={s} data-n={i + 1}>
                  {s}
                </li>
              ))}
            </ol>
          </div>
          <div className="story-stage" role="img" aria-label={phoneLabel}>
            <div className="story-glow" />
            <Phone className="story-phone">
              <div
                className="story-screen"
                style={{ '--strip-max': `${STRIP_MAX_PCT.toFixed(3)}%` } as React.CSSProperties}
              >
                <picture className="story-strip">
                  <source type="image/avif" srcSet="/devices/dahab-story-900.avif" />
                  <img
                    src="/devices/dahab-story-900.webp"
                    width={STORY_STRIP.w}
                    height={STORY_STRIP.h}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                </picture>
                {'bar' in DEVICE_SHOTS.dahab && (
                  <picture className="story-bar">
                    <source type="image/avif" srcSet="/devices/dahab-bar-900.avif" />
                    <img
                      src="/devices/dahab-bar-900.webp"
                      width={900}
                      height={Math.round(
                        (900 * DEVICE_SHOTS.dahab.bar.h) / DEVICE_SHOTS.dahab.bar.w
                      )}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </picture>
                )}
              </div>
              <ol className="story-toasts" aria-hidden="true">
                {toasts.map((n, i) => (
                  <li key={n.t} className="story-toast" style={{ '--i': i } as React.CSSProperties}>
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
