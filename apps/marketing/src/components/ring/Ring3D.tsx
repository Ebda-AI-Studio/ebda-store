'use client';

import { useEffect, useRef, useState } from 'react';
import type { Metal, RingScene, Stone } from './ring-scene';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface RingLabels {
  label: string;
  hint: string;
  metalLabel: string;
  stoneLabel: string;
  metals: Record<Metal, string>;
  stones: Record<Stone, string>;
}

const METALS: Metal[] = ['gold', 'white', 'rose'];
const STONES: Stone[] = ['diamond', 'emerald', 'ruby'];

/**
 * A live 3D ring (three.js, lazy): a poster first, the WebGL scene only once the section is
 * within ~a screen of the viewport. Scroll turns it, dragging spins it, swatches swap the metal
 * and the stone. Reduced motion keeps the poster (per-metal stills, so the swatches still work).
 */
export function Ring3D({ l }: { l: RingLabels }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<RingScene | null>(null);
  const [metal, setMetal] = useState<Metal>('gold');
  const [stone, setStone] = useState<Stone>('diamond');
  const [live, setLive] = useState(false);

  useEffect(() => {
    sceneRef.current?.setMetal(metal);
  }, [metal]);
  useEffect(() => {
    sceneRef.current?.setStone(stone);
  }, [stone]);

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    let disposed = false;
    let raf = 0;
    let visible = false;
    let drag = 0;
    let dragging = false;
    let lastX = 0;
    let velocity = 0;
    let ro: ResizeObserver | null = null;

    const progress = () => {
      const r = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight + r.height)));
    };
    const frame = (t: number) => {
      raf = 0;
      const s = sceneRef.current;
      if (!s || disposed) return;
      if (!dragging) {
        drag += velocity;
        velocity *= 0.94;
      }
      s.setYaw(progress() * Math.PI * 2.2 + drag + Math.sin(t / 2400) * 0.06);
      s.render();
      if (visible) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = (e.clientX - lastX) / 120;
      drag += dx;
      velocity = dx;
      lastX = e.clientX;
      kick();
    };
    const onUp = () => {
      dragging = false;
    };

    const load = async () => {
      const { createRingScene } = await import('./ring-scene');
      if (disposed) return;
      const s = createRingScene(cv, { pixelRatio: devicePixelRatio || 1 });
      sceneRef.current = s;
      s.setMetal(metal);
      s.setStone(stone);
      const size = () => s.resize(cv.clientWidth, cv.clientHeight);
      size();
      ro = new ResizeObserver(size);
      ro.observe(cv);
      s.setYaw(progress() * Math.PI * 2.2);
      s.render();
      setLive(true);
      cv.addEventListener('pointerdown', onDown);
      cv.addEventListener('pointermove', onMove);
      cv.addEventListener('pointerup', onUp);
      cv.addEventListener('pointercancel', onUp);
      kick();
    };

    const near = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          near.disconnect();
          void load();
        }
      },
      { rootMargin: '900px 0px' }
    );
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    near.observe(el);
    seen.observe(el);
    return () => {
      disposed = true;
      near.disconnect();
      seen.disconnect();
      ro?.disconnect();
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      if (raf) cancelAnimationFrame(raf);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // Run once; metal/stone changes reach the scene through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ring3d">
      <div
        ref={wrap}
        className="ring-stage"
        data-live={live ? '1' : undefined}
        role="img"
        aria-label={l.label}
      >
        <picture className="ring-poster">
          <source type="image/avif" srcSet={`/ring/ring-${metal}-${stone}.avif`} />
          <img
            src={`/ring/ring-${metal}-${stone}.webp`}
            width={900}
            height={900}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </picture>
        <canvas ref={canvas} className="ring-canvas" aria-hidden="true" />
      </div>
      <p className="ring-hint muted small">{l.hint}</p>
      <div className="ring-swatches">
        <div role="group" aria-label={l.metalLabel} className="swatch-row">
          {METALS.map(m => (
            <button
              key={m}
              type="button"
              className="swatch"
              data-metal={m}
              aria-pressed={metal === m}
              onClick={() => setMetal(m)}
            >
              <span className="swatch-dot" aria-hidden="true" />
              {l.metals[m]}
            </button>
          ))}
        </div>
        <div role="group" aria-label={l.stoneLabel} className="swatch-row">
          {STONES.map(s => (
            <button
              key={s}
              type="button"
              className="swatch"
              data-stone={s}
              aria-pressed={stone === s}
              onClick={() => setStone(s)}
            >
              <span className="swatch-dot" aria-hidden="true" />
              {l.stones[s]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
