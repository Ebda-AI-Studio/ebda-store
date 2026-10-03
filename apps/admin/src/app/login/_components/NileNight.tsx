'use client';

import { useEffect, useRef } from 'react';

/**
 * "Nile at night from orbit — each light is a store."
 * Port of the hero script in docs/ebda/brand/ebda-brief-v2.html.
 * Decorative only: the canvas is aria-hidden and ignores pointer events.
 */

const NIGHT = '#0A0B0C';

interface Pt {
  x: number;
  y: number;
  s: number;
  a: number;
  p: number;
  g: number;
  city?: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function build(W: number, H: number): Pt[] {
  const pts: Pt[] = [];
  const cx = W * (W > 700 ? 0.7 : 0.62);
  const top = H * 0.05;
  const deltaY = H * 0.4;
  const bottom = H * 1.05;
  const n = Math.round(Math.min(2600, (W * H) / 180));
  for (let i = 0; i < n; i++) {
    let px: number;
    let py: number;
    if (Math.random() < 0.46) {
      // the Delta fan
      const t = Math.pow(Math.random(), 0.8);
      const ang = gauss() * 0.62;
      const r = t * (deltaY - top);
      px = cx + Math.sin(ang) * r * 2.1;
      py = deltaY - Math.cos(ang) * r * 0.95;
    } else {
      // the valley ribbon, gently meandering
      py = rnd(deltaY, bottom);
      const k = (py - deltaY) / (bottom - deltaY);
      const bend = Math.sin(k * 5.2) * W * 0.035 + Math.sin(k * 13) * W * 0.008 - k * W * 0.03;
      px = cx + bend + gauss() * (10 + k * 5);
    }
    const b = Math.random();
    pts.push({
      x: px,
      y: py,
      s: b < 0.03 ? rnd(1.4, 2.2) : rnd(0.4, 1.1),
      a: rnd(0.25, 0.95),
      p: rnd(0, 6.28),
      g: 0,
    });
  }
  // Cairo and Alexandria glow
  pts.push({ x: cx, y: deltaY + 4, s: 0, a: 0, p: 0, g: 0, city: 28 });
  pts.push({
    x: cx - (deltaY - top) * 0.72,
    y: top + (deltaY - top) * 0.12,
    s: 0,
    a: 0,
    p: 0,
    g: 0,
    city: 18,
  });
  return pts;
}

function lightRandomStore(pts: Pt[]) {
  const p = pts[(Math.random() * (pts.length - 2)) | 0];
  if (p && !p.city) p.g = 1;
}

function draw(
  x: CanvasRenderingContext2D,
  W: number,
  H: number,
  pts: Pt[],
  t: number,
  reduce: boolean
) {
  x.fillStyle = NIGHT;
  x.fillRect(0, 0, W, H);
  for (const p of pts) {
    if (p.city) {
      const gr = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.city);
      gr.addColorStop(0, 'rgba(243,245,244,.22)');
      gr.addColorStop(1, 'rgba(243,245,244,0)');
      x.fillStyle = gr;
      x.beginPath();
      x.arc(p.x, p.y, p.city, 0, 6.28);
      x.fill();
      continue;
    }
    const tw = reduce ? 1 : 0.75 + 0.25 * Math.sin(t * 0.0012 + p.p);
    if (p.g > 0) {
      // a store opening: Antique Gold lift
      const k = p.g;
      x.fillStyle = `rgba(203,168,115,${Math.min(1, k)})`;
      x.beginPath();
      x.arc(p.x, p.y, p.s + 1.2, 0, 6.28);
      x.fill();
      x.fillStyle = `rgba(203,168,115,${k * 0.2})`;
      x.beginPath();
      x.arc(p.x, p.y, 6 + (1 - k) * 10, 0, 6.28);
      x.fill();
      if (!reduce) p.g -= 0.006;
    } else {
      x.fillStyle = `rgba(233,238,236,${p.a * tw})`;
      x.fillRect(p.x, p.y, p.s, p.s);
    }
  }
  if (!reduce && Math.random() < 0.05) lightRandomStore(pts);
  // darken the foot so overlaid copy stays readable
  const fb = x.createLinearGradient(0, H * 0.55, 0, H);
  fb.addColorStop(0, 'rgba(10,11,12,0)');
  fb.addColorStop(1, 'rgba(10,11,12,.85)');
  x.fillStyle = fb;
  x.fillRect(0, 0, W, H);
}

export function NileNight({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const x = c?.getContext('2d');
    if (!c || !x) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0;
    let H = 0;
    let pts: Pt[] = [];
    let raf = 0;

    const staticFrame = () => {
      for (let i = 0; i < 14; i++) lightRandomStore(pts);
      draw(x, W, H, pts, 0, true);
    };
    const loop = (t: number) => {
      draw(x, W, H, pts, t, false);
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = c.clientWidth;
      H = c.clientHeight;
      if (!W || !H) return;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      pts = build(W, H);
      if (reduce) staticFrame();
    };

    resize();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(c);
    }
    if (reduce) {
      return () => ro?.disconnect();
    }
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();
    return () => {
      stop();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className ?? ''}`}
    />
  );
}

export default NileNight;
