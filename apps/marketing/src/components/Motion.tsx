'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEMO_STORES, TEMPLATE_IDS, type TemplateId } from '../lib/demo-stores';
import type { Locale } from '../lib/site';
import { DemoStore, Laptop, Phone, Tablet } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Palettes the story phone cycles through on step 3 (products stay the same). */
const STORY_PALETTES: TemplateId[] = ['lamma', 'jasmine', 'dahab', 'qamar', 'lamma'];

/**
 * The pinned scroll story. The server renders the finished state (step 4) so no-JS,
 * reduced-motion and crawlers see the whole store; on scroll we drive --p and data-step.
 */
export function StoryScroll({
  locale,
  title,
  steps,
  orderTitle,
  orderBody,
  phoneLabel,
}: {
  locale: Locale;
  title: string;
  steps: string[];
  orderTitle: string;
  orderBody: string;
  phoneLabel: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [palette, setPalette] = useState<TemplateId>('lamma');

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let raf = 0;
    let lastPal: TemplateId = 'lamma';
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      const step = p < 0.12 ? 0 : p < 0.3 ? 1 : p < 0.5 ? 2 : p < 0.78 ? 3 : 4;
      el.style.setProperty('--p', p.toFixed(4));
      el.style.setProperty('--in', Math.min(1, p / 0.12).toFixed(4));
      el.dataset.step = String(step);
      const pal =
        step === 3 ? STORY_PALETTES[Math.min(4, Math.floor(((p - 0.5) / 0.28) * 5))] : 'lamma';
      if (pal !== lastPal) {
        lastPal = pal;
        setPalette(pal);
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
              <DemoStore tpl="lamma" palette={palette} locale={locale} sizes="140px" />
              <div className="story-toast" aria-hidden="true">
                <span className="toast-mark" />
                <span>
                  <strong>{orderTitle}</strong>
                  <span>{orderBody}</span>
                </span>
              </div>
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
          <DemoStore tpl={tpl} locale={locale} sizes="(min-width: 900px) 140px, 90px" />
        </Laptop>
        <Tablet className="devices-tablet">
          <DemoStore tpl={tpl} locale={locale} sizes="110px" />
        </Tablet>
        <Phone className="devices-phone">
          <DemoStore tpl={tpl} locale={locale} sizes="80px" />
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
