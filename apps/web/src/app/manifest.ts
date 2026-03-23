import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';

/**
 * Convert HSL string (e.g. "26 100% 50%") to hex color.
 * Falls back to the input if it's already a hex color or can't be parsed.
 */
function hslToHex(hsl: string): string {
  if (hsl.startsWith('#')) return hsl;
  const parts = hsl.match(/(\d+(?:\.\d+)?)/g);
  if (!parts || parts.length < 3) return '#ff6e00';
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const store = await getStore();
  const primaryColor = store.theme?.primaryColor || '#ff6e00';

  return {
    name: store.name,
    short_name: store.name,
    description: store.metaDescription || `Shop at ${store.name}`,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: hslToHex(primaryColor),
    icons: [
      ...(store.favicon
        ? [
            { src: store.favicon, sizes: '192x192', type: 'image/png' },
            { src: store.favicon, sizes: '512x512', type: 'image/png' },
          ]
        : [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          ]),
    ],
  };
}
