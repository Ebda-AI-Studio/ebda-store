/**
 * Browser-side QR output (QR-1): canvas PNG, SVG file, print PDF. Everything is derived from the
 * same `Scene` the live preview and the scan self-check use. `buildPdf` is pure (no DOM) so it is
 * unit-tested; only `renderToCanvas`, `canvasToPng`, `compressRgb` and the download helpers need a browser.
 */
import { decodeBitmap, type Scene } from '@ebda/shared/qr';

const FONT = "Cairo, 'Noto Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Paint the scene (+ optional logo image, label text) at `widthPx` wide. Returns the canvas. */
export function renderToCanvas(
  scene: Scene,
  widthPx: number,
  logo?: CanvasImageSource | null
): HTMLCanvasElement {
  const k = widthPx / scene.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(scene.width * k);
  canvas.height = Math.round(scene.height * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas unavailable');
  ctx.scale(k, k);
  for (const s of scene.shapes) {
    ctx.fillStyle = s.fill;
    if (s.t === 'circle') {
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.r > 0) {
      roundRectPath(ctx, s.x, s.y, s.w, s.h, s.r);
      ctx.fill();
    } else {
      ctx.fillRect(s.x, s.y, s.w, s.h);
    }
  }
  if (scene.logo && logo) {
    const inset = 10;
    const box = scene.logo.size - 2 * inset;
    const w = (logo as { width?: number }).width || box;
    const h = (logo as { height?: number }).height || box;
    const f = Math.min(box / w, box / h);
    ctx.drawImage(
      logo,
      scene.logo.x + inset + (box - w * f) / 2,
      scene.logo.y + inset + (box - h * f) / 2,
      w * f,
      h * f
    );
  }
  if (scene.label) {
    const t = scene.label;
    ctx.fillStyle = t.color;
    ctx.font = `700 ${Math.min(t.h * 0.42, 34)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = t.rtl ? 'rtl' : 'ltr';
    ctx.fillText(t.text, t.x + t.w / 2, t.y + t.h / 2, t.w - 20);
  }
  return canvas;
}

/**
 * Decode the REAL rendered code (the canvas that becomes the PNG/PDF), not a model of it.
 * Download is refused unless this returns the exact payload.
 */
export function decodeCanvas(canvas: HTMLCanvasElement, scene: Scene): string | null {
  const k = canvas.width / scene.width;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const { x, y, size } = scene.code;
  const img = ctx.getImageData(
    Math.floor(x * k),
    Math.floor(y * k),
    Math.ceil(size * k),
    Math.ceil(size * k)
  );
  return decodeBitmap({ width: img.width, height: img.height, data: img.data });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), type)
  );
}

/** zlib-compress raw RGB for a PDF FlateDecode stream (CompressionStream 'deflate' = zlib). */
export async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function canvasToRgb(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas unavailable');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgb = new Uint8Array(width * height * 3);
  // Composite over white: the card frame has rounded corners that are transparent, and a PDF
  // image has no alpha, so they would otherwise print black.
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const a = data[i + 3];
    rgb[j] = Math.round((data[i] * a) / 255 + 255 - a);
    rgb[j + 1] = Math.round((data[i + 1] * a) / 255 + 255 - a);
    rgb[j + 2] = Math.round((data[i + 2] * a) / 255 + 255 - a);
  }
  return rgb;
}

const MM_TO_PT = 72 / 25.4;

export type PdfSpec = {
  widthPx: number;
  heightPx: number;
  /** zlib-deflated 8-bit RGB, row-major, no alpha. */
  deflatedRgb: Uint8Array;
  /** Printed width of the artwork; height follows the aspect ratio. */
  printWidthMm: number;
  /** White margin around the artwork (cut / bleed-safe). */
  marginMm: number;
  title: string;
};

const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * One-page print PDF: the artwork placed at an exact physical size. The raster is rendered at
 * 300 dpi by the caller, so the PDF is print-ready without an embedded font (Arabic text is
 * part of the image). Pure: returns the file bytes.
 */
export function buildPdf(spec: PdfSpec): Uint8Array {
  const imgW = spec.printWidthMm * MM_TO_PT;
  const imgH = (imgW * spec.heightPx) / spec.widthPx;
  const m = spec.marginMm * MM_TO_PT;
  const pageW = imgW + 2 * m;
  const pageH = imgH + 2 * m;
  const f = (n: number) => n.toFixed(2);
  const title = spec.title.replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '') || 'QR code';

  const content = `q ${f(imgW)} 0 0 ${f(imgH)} ${f(m)} ${f(m)} cm /Im0 Do Q`;
  const objs: Uint8Array[][] = [
    [ascii('<< /Type /Catalog /Pages 2 0 R >>')],
    [ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pageW)} ${f(pageH)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
      ),
    ],
    [
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${spec.widthPx} /Height ${spec.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${spec.deflatedRgb.length} >>\nstream\n`
      ),
      spec.deflatedRgb,
      ascii('\nendstream'),
    ],
    [ascii(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)],
    [ascii(`<< /Title (${title}) /Producer (Ebda Store) >>`)],
  ];

  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((parts, i) => {
    offsets.push(offset);
    const head = ascii(`${i + 1} 0 obj\n`);
    const tail = ascii('\nendobj\n');
    for (const c of [head, ...parts, tail]) {
      chunks.push(c);
      offset += c.length;
    }
  });
  const xrefAt = offset;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(ascii(xref));

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ASCII-safe file name stem from a store/product label. */
export function fileStem(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `qr-${s || 'code'}`;
}
