import { decodeQR } from 'qr/decode.js';
import { buildScene } from './scene';
import { rasterizeScene, type Bitmap } from './raster';
import { validateColours, type DesignProblem } from './contrast';
import type { QrDesign } from './schema';

export type SelfCheck = {
  ok: boolean;
  decoded: string | null;
  problems: Array<DesignProblem | 'unreadable'>;
};

/** Decode an RGBA bitmap; null when no code can be read. */
export function decodeBitmap(bmp: Bitmap): string | null {
  try {
    return decodeQR({ width: bmp.width, height: bmp.height, data: bmp.data });
  } catch {
    return null;
  }
}

/**
 * Scan self-check (QR-1): paint the design, decode it with an independent decoder and require
 * the exact payload back. A logo design is decoded twice, with the hole empty AND solid in the
 * foreground colour, because a real logo is neither. A failing result blocks save and download.
 */
export function selfCheck(payload: string, d: QrDesign, pxPerModule = 8): SelfCheck {
  const problems: SelfCheck['problems'] = validateColours(d.fg, d.bg);
  if (problems.length) return { ok: false, decoded: null, problems };
  const scene = buildScene(payload, d);
  const variants = scene.logo ? [{ color: d.bg }, { color: d.fg }] : [undefined];
  let decoded: string | null = null;
  for (const v of variants) {
    decoded = decodeBitmap(rasterizeScene(scene, pxPerModule, v ? { logoFill: v } : {}));
    if (decoded !== payload) return { ok: false, decoded, problems: ['unreadable'] };
  }
  return { ok: true, decoded, problems: [] };
}
