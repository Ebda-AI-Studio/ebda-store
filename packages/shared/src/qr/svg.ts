import type { Scene, Shape } from './scene';

const FONT = "Cairo, 'Noto Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const n = (v: number) => Math.round(v * 100) / 100;

function shapeToSvg(s: Shape): string {
  if (s.t === 'circle')
    return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}" fill="${s.fill}"/>`;
  const rx = s.r ? ` rx="${n(s.r)}"` : '';
  return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${rx} fill="${s.fill}"/>`;
}

/**
 * Standalone SVG. `logoHref` must be a data: URL (the caller embeds the image so the file is
 * self-contained). Colours come from validated #rrggbb values; every string is XML-escaped.
 */
export function sceneToSvg(scene: Scene, logoHref?: string): string {
  const parts = scene.shapes.map(shapeToSvg);
  if (
    scene.logo &&
    logoHref &&
    /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logoHref)
  ) {
    const l = scene.logo;
    const inset = 10;
    parts.push(
      `<image x="${n(l.x + inset)}" y="${n(l.y + inset)}" width="${n(l.size - 2 * inset)}" height="${n(l.size - 2 * inset)}" preserveAspectRatio="xMidYMid meet" href="${logoHref}"/>`
    );
  }
  if (scene.label) {
    const t = scene.label;
    const size = Math.min(t.h * 0.42, 34);
    // Same cap the canvas applies (fillText maxWidth): a long line is squeezed, never overflows the frame.
    const maxW = t.w - 20;
    const fit =
      [...t.text].length * size * 0.62 > maxW
        ? ` textLength="${n(maxW)}" lengthAdjust="spacingAndGlyphs"`
        : '';
    parts.push(
      `<text x="${n(t.x + t.w / 2)}" y="${n(t.y + t.h / 2)}" font-family="${FONT}" font-size="${n(size)}" font-weight="700" fill="${t.color}" text-anchor="middle" dominant-baseline="central"${fit} direction="${t.rtl ? 'rtl' : 'ltr'}">${xmlEscape(t.text)}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(scene.width)} ${n(scene.height)}" width="${n(scene.width)}" height="${n(scene.height)}" shape-rendering="geometricPrecision">${parts.join('')}</svg>`;
}
