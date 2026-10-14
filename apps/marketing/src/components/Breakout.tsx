'use client';

import { useEffect, useRef } from 'react';
import { Phone } from './Devices';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Pinned break-out: the Dahab ring leaves the phone and stays pinned while the next
 * section's gold wipes up beneath it, with giant outlined words drifting behind at three
 * different speeds. Scroll drives one variable (--p); without JS or with reduced motion the
 * section renders its finished frame, un-pinned.
 */
export function Breakout({ title, words }: { title: string; words: [string, string, string] }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      el.style.setProperty('--p', p.toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    let on = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !on) {
        on = true;
        addEventListener('scroll', onScroll, { passive: true });
        addEventListener('resize', onScroll);
        onScroll();
      } else if (!e.isIntersecting && on) {
        on = false;
        removeEventListener('scroll', onScroll);
        removeEventListener('resize', onScroll);
      }
    });
    el.dataset.live = '1';
    update();
    io.observe(el);
    return () => {
      io.disconnect();
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section id="breakout" ref={ref} className="breakout" aria-labelledby="breakout-h">
      <div className="bo-sticky">
        <div className="bo-wipe" aria-hidden="true" />
        <div className="bo-words" aria-hidden="true">
          {words.map((w, i) => (
            <span key={w} className="bo-word" style={{ '--row': i } as React.CSSProperties}>
              {w} {w} {w}
            </span>
          ))}
        </div>
        <div className="bo-stage">
          <Phone className="bo-phone">
            <picture className="shot">
              <source
                type="image/avif"
                srcSet="/looks/phone-600.avif 600w, /looks/phone-900.avif 900w"
                sizes="280px"
              />
              <img
                src="/looks/phone-900.webp"
                srcSet="/looks/phone-600.webp 600w, /looks/phone-900.webp 900w"
                sizes="280px"
                width={900}
                height={1948}
                alt=""
                loading="lazy"
                decoding="async"
              />
            </picture>
          </Phone>
          <picture className="bo-ring" aria-hidden="true">
            <source type="image/avif" srcSet="/ring/ring-gold-diamond.avif" />
            <img
              src="/ring/ring-gold-diamond.webp"
              width={900}
              height={900}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </picture>
        </div>
        <h2 id="breakout-h" className="bo-title">
          {title}
        </h2>
      </div>
    </section>
  );
}
