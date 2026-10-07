'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEMO_STORES, TEMPLATE_IDS, type TemplateId } from '../lib/demo-stores';
import { DEVICE_SHOTS, STORY_STRIP } from '../lib/device-shots';
import type { Locale } from '../lib/site';
import { Laptop, Phone, Screen, Tablet } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Templates the story phone flips through on step 3 ("restyle it in one tap"). */
const STORY_SWAPS: TemplateId[] = ['jasmine', 'dahab', 'qamar', 'souq', 'lamma'];

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
  const [swap, setSwap] = useState<TemplateId | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let raf = 0;
    let lastSwap: TemplateId | null = null;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      const step = p < 0.12 ? 0 : p < 0.3 ? 1 : p < 0.5 ? 2 : p < 0.78 ? 3 : 4;
      el.style.setProperty('--p', p.toFixed(4));
      el.style.setProperty('--in', Math.min(1, p / 0.12).toFixed(4));
      el.dataset.step = String(step);
      // Steps 1-2: the real Lamma storefront scrolls inside the phone down to its products.
      el.style.setProperty(
        '--scroll',
        (Math.min(1, Math.max(0, (p - 0.12) / 0.33)) * 0.62).toFixed(4)
      );
      // Step 3: the same phone flips through the other real templates.
      const next = step === 3 ? STORY_SWAPS[Math.min(4, Math.floor(((p - 0.5) / 0.28) * 5))] : null;
      if (next !== lastSwap) {
        lastSwap = next;
        setSwap(next === 'lamma' ? null : next);
      }
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
                  <source type="image/avif" srcSet="/devices/lamma-story-600.avif" />
                  <img
                    src="/devices/lamma-story-600.webp"
                    width={STORY_STRIP.w}
                    height={STORY_STRIP.h}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                </picture>
                {'bar' in DEVICE_SHOTS.lamma && (
                  <picture className="story-bar">
                    <source type="image/avif" srcSet="/devices/lamma-bar-600.avif" />
                    <img
                      src="/devices/lamma-bar-600.webp"
                      width={600}
                      height={Math.round(
                        (600 * DEVICE_SHOTS.lamma.bar.h) / DEVICE_SHOTS.lamma.bar.w
                      )}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </picture>
                )}
                {STORY_SWAPS.filter(t => t !== 'lamma').map(t => (
                  <div key={t} className="story-swap" data-on={swap === t ? '1' : undefined}>
                    <Screen tpl={t} device="phone" sizes="300px" />
                  </div>
                ))}
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

/** Template switcher: tap a family, all three devices restyle and swap products live. */
export function TemplateShowcase({
  locale,
  groupLabel,
  devicesLabel,
}: {
  locale: Locale;
  groupLabel: string;
  devicesLabel: string;
}) {
  const [tpl, setTpl] = useState<TemplateId>('souq');
  return (
    <div className="showcase">
      <div className="tpl-tabs" role="group" aria-label={groupLabel}>
        {TEMPLATE_IDS.map(id => (
          <button
            key={id}
            type="button"
            className="tpl-tab"
            data-pal={id}
            aria-pressed={tpl === id}
            onClick={() => setTpl(id)}
          >
            <span className="tpl-swatch" aria-hidden="true" />
            <span className="tpl-name">{DEMO_STORES[id].template[locale]}</span>
            <span className="tpl-kind">{DEMO_STORES[id].kind[locale]}</span>
          </button>
        ))}
      </div>
      <div
        className="devices"
        role="img"
        aria-label={`${devicesLabel}: ${DEMO_STORES[tpl].template[locale]}`}
      >
        <Laptop className="devices-laptop">
          <Screen tpl={tpl} device="laptop" sizes="(min-width: 700px) 620px, 92vw" />
        </Laptop>
        <Tablet className="devices-tablet">
          <Screen tpl={tpl} device="tablet" sizes="200px" />
        </Tablet>
        <Phone className="devices-phone">
          <Screen tpl={tpl} device="phone" sizes="140px" />
        </Phone>
      </div>
    </div>
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
