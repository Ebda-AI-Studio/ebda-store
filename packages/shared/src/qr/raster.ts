import type { Scene, Shape } from './scene';

export type Bitmap = { width: number; height: number; data: Uint8ClampedArray };

function rgb(hexColor: string): [number, number, number] {
  return [
    parseInt(hexColor.slice(1, 3), 16),
    parseInt(hexColor.slice(3, 5), 16),
    parseInt(hexColor.slice(5, 7), 16),
  ];
}

function insideRounded(px: number, py: number, s: Extract<Shape, { t: 'rect' }>): boolean {
  if (px < s.x || px >= s.x + s.w || py < s.y || py >= s.y + s.h) return false;
  const r = Math.min(s.r, s.w / 2, s.h / 2);
  if (r <= 0) return true;
  const dx = px < s.x + r ? s.x + r - px : px > s.x + s.w - r ? px - (s.x + s.w - r) : 0;
  const dy = py < s.y + r ? s.y + r - py : py > s.y + s.h - r ? py - (s.y + s.h - r) : 0;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Pure-JS painter (no DOM) used by the scan self-check and tests. `logoFill` paints the logo
 * hole: 'bg' (empty plate) or 'fg' (solid block, a worst case for a dark logo).
 * Text is not painted: it never sits inside the code's quiet zone.
 */
export function rasterizeScene(
  scene: Scene,
  pxPerModule: number,
  opts: { logoFill?: { color: string } } = {}
): Bitmap {
  const k = pxPerModule / 10;
  const width = Math.ceil(scene.width * k);
  const height = Math.ceil(scene.height * k);
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    hit: (ux: number, uy: number) => boolean,
    color: string
  ) => {
    const [r, g, b] = rgb(color);
    const ix0 = Math.max(0, Math.floor(x0 * k));
    const iy0 = Math.max(0, Math.floor(y0 * k));
    const ix1 = Math.min(width - 1, Math.ceil(x1 * k));
    const iy1 = Math.min(height - 1, Math.ceil(y1 * k));
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        if (!hit((x + 0.5) / k, (y + 0.5) / k)) continue;
        const o = (y * width + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
  };
  for (const s of scene.shapes) {
    if (s.t === 'circle') {
      paint(
        s.cx - s.r,
        s.cy - s.r,
        s.cx + s.r,
        s.cy + s.r,
        (ux, uy) => (ux - s.cx) ** 2 + (uy - s.cy) ** 2 <= s.r * s.r,
        s.fill
      );
    } else {
      paint(s.x, s.y, s.x + s.w, s.y + s.h, (ux, uy) => insideRounded(ux, uy, s), s.fill);
    }
  }
  if (scene.logo && opts.logoFill) {
    const l = scene.logo;
    paint(l.x, l.y, l.x + l.size, l.y + l.size, () => true, opts.logoFill.color);
  }
  return { width, height, data };
}
