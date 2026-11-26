/**
 * Product label output (BARCODE-1): draw a laid-out label to a canvas, read the barcode back with
 * the in-house reader, and assemble a multi-page PDF (A4 sticker sheets or one page per roll
 * label). `buildPagesPdf` is pure (unit-tested); the canvas functions need a browser.
 */
import {
  barcodeShapeData,
  code128Modules,
  ean13Modules,
  parseBarcodeInput,
  renderBarcodeSvg,
  selfCheckLinear,
  A4_MM,
  sheetCell,
  type LabelLayout,
  type LabelPreset,
} from '@ebda/shared';
import { renderToCanvas } from './qr-export';
import type { Scene } from '@ebda/shared/qr';

const FONT = "Cairo, 'Noto Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";
export const LABEL_DPI = 300;
const PX_PER_MM = LABEL_DPI / 25.4;
const MM_TO_PT = 72 / 25.4;
const QUIET_EAN = { left: 11, right: 7 };
const QUIET_128 = 10;

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('shape render failed'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export type LabelRenderInput = {
  layout: LabelLayout;
  /** Scene of the store QR when `layout.qr` is set. */
  qrScene?: Scene | null;
};

/** Draw one label at 300 dpi onto a fresh canvas (white paper, black ink). */
export async function renderLabelCanvas({
  layout,
  qrScene,
}: LabelRenderInput): Promise<HTMLCanvasElement> {
  const k = PX_PER_MM;
  // Cairo may not be loaded yet on the first render: wait so Arabic widths match the PDF.
  try {
    await document.fonts.load(`700 12px Cairo`);
  } catch {
    /* fall back to the system stack */
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.widthMm * k);
  canvas.height = Math.round(layout.heightMm * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';

  for (const t of layout.texts) {
    ctx.font = `${t.bold ? 700 : 500} ${t.size * k}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.direction = t.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = t.align === 'center' ? 'center' : t.rtl ? 'right' : 'left';
    const x = t.align === 'center' ? t.x + t.w / 2 : t.rtl ? t.x + t.w : t.x;
    ctx.fillText(t.text, x * k, (t.y + t.h / 2) * k, t.w * k);
  }

  const b = layout.barcode;
  if (b.shape === 'plain') {
    const parsed = parseBarcodeInput(b.value);
    let mods: boolean[];
    let ql: number;
    let qr: number;
    if (b.symbology === 'ean13' && parsed.ok) {
      mods = ean13Modules(parsed.kind === 'upca' ? `0${parsed.value}` : parsed.value);
      ql = QUIET_EAN.left;
      qr = QUIET_EAN.right;
    } else {
      mods = code128Modules(b.value);
      ql = qr = QUIET_128;
    }
    const mw = b.art.w / (mods.length + ql + qr);
    for (let i = 0; i < mods.length; ) {
      if (!mods[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < mods.length && mods[j]) j++;
      // Snap to whole pixels so every bar edge is crisp on the thermal head.
      const x0 = Math.round((b.art.x + (ql + i) * mw) * k);
      const x1 = Math.round((b.art.x + (ql + j) * mw) * k);
      ctx.fillRect(x0, Math.round(b.art.y * k), Math.max(1, x1 - x0), Math.round(b.art.h * k));
      i = j;
    }
  } else if (barcodeShapeData(b.shape)) {
    const img = await loadSvgImage(
      renderBarcodeSvg({ value: b.value, shape: b.shape, label: false, ink: '#000000' })
    );
    ctx.drawImage(img, b.art.x * k, b.art.y * k, b.art.w * k, b.art.h * k);
  }

  if (layout.qr && qrScene) {
    const q = renderToCanvas(qrScene, Math.round(layout.qr.size * k));
    ctx.drawImage(
      q,
      layout.qr.x * k,
      layout.qr.y * k,
      layout.qr.size * k,
      layout.qr.size * k * (q.height / q.width)
    );
  }
  return canvas;
}

/**
 * Rasterise a barcode SVG at `widthPx` (1x CSS size = the worst case) and read it back with the
 * in-house reader. Used by the receipt-barcode tab and any preview that shows a shaped code.
 */
export async function checkSvgBarcode(
  svg: string,
  expected: string,
  widthPx = 360
): Promise<boolean> {
  const img = await loadSvgImage(svg);
  const w = widthPx;
  const h = Math.max(
    1,
    Math.round(
      (widthPx * (img.naturalHeight || img.height || 1)) / (img.naturalWidth || img.width || 1)
    )
  );
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return selfCheckLinear({ width: w, height: h, data: data.data }, expected).ok;
}

export type LabelCheck = { ok: boolean; reason: 'ok' | 'not-printable' | 'unreadable' };

/** Read the barcode back from the REAL canvas pixels (the bars region only). */
export function checkLabelCanvas(canvas: HTMLCanvasElement, layout: LabelLayout): LabelCheck {
  if (!layout.printable) return { ok: false, reason: 'not-printable' };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { ok: false, reason: 'unreadable' };
  const k = PX_PER_MM;
  const a = layout.barcode.art;
  const pad = Math.round(1.5 * k);
  const x = Math.max(0, Math.floor(a.x * k) - pad);
  const y = Math.floor(a.y * k);
  const w = Math.min(canvas.width - x, Math.ceil(a.w * k) + 2 * pad);
  const h = Math.min(canvas.height - y, Math.ceil(a.h * k));
  const img = ctx.getImageData(x, y, w, h);
  const parsed = parseBarcodeInput(layout.barcode.value);
  const expected = parsed.ok ? parsed.value : layout.barcode.value;
  const r = selfCheckLinear({ width: img.width, height: img.height, data: img.data }, expected);
  return r.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: 'unreadable' };
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

export type PdfImage = { widthPx: number; heightPx: number; deflatedRgb: Uint8Array };
export type PdfPlacement = { image: number; xMm: number; yMm: number; wMm: number; hMm: number };
export type PdfPage = { widthMm: number; heightMm: number; placements: PdfPlacement[] };

const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * Pure multi-page PDF writer. `yMm` is measured from the TOP of the page (like the preset
 * margins). One image object per unique label, placed as many times as needed, so a 65-up sheet
 * of one label embeds it once.
 */
export function buildPagesPdf(spec: {
  images: PdfImage[];
  pages: PdfPage[];
  title: string;
}): Uint8Array {
  const f = (n: number) => n.toFixed(2);
  const title = spec.title.replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '') || 'Labels';
  // object ids: 1 catalog, 2 pages, 3 info, images, then (page, content) pairs
  const imageId = (i: number) => 4 + i;
  const pageId = (p: number) => 4 + spec.images.length + p * 2;
  const contentId = (p: number) => pageId(p) + 1;
  const total = 3 + spec.images.length + spec.pages.length * 2;
  const objs = new Map<number, Uint8Array[]>();

  objs.set(1, [ascii('<< /Type /Catalog /Pages 2 0 R >>')]);
  objs.set(2, [
    ascii(
      `<< /Type /Pages /Kids [${spec.pages.map((_, p) => `${pageId(p)} 0 R`).join(' ')}] /Count ${spec.pages.length} >>`
    ),
  ]);
  objs.set(3, [ascii(`<< /Title (${title}) /Producer (Ebda Store) >>`)]);
  spec.images.forEach((im, i) =>
    objs.set(imageId(i), [
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${im.widthPx} /Height ${im.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${im.deflatedRgb.length} >>\nstream\n`
      ),
      im.deflatedRgb,
      ascii('\nendstream'),
    ])
  );
  spec.pages.forEach((pg, p) => {
    const wPt = pg.widthMm * MM_TO_PT;
    const hPt = pg.heightMm * MM_TO_PT;
    const used = [...new Set(pg.placements.map(pl => pl.image))];
    const xobjects = used.map(i => `/Im${i} ${imageId(i)} 0 R`).join(' ');
    const content = pg.placements
      .map(pl => {
        const w = pl.wMm * MM_TO_PT;
        const h = pl.hMm * MM_TO_PT;
        const x = pl.xMm * MM_TO_PT;
        const y = hPt - (pl.yMm + pl.hMm) * MM_TO_PT;
        return `q ${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm /Im${pl.image} Do Q`;
      })
      .join('\n');
    objs.set(pageId(p), [
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(wPt)} ${f(hPt)}] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentId(p)} 0 R >>`
      ),
    ]);
    objs.set(contentId(p), [
      ascii(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    ]);
  });

  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  for (let id = 1; id <= total; id++) {
    offsets.push(offset);
    for (const c of [ascii(`${id} 0 obj\n`), ...objs.get(id)!, ascii('\nendobj\n')]) {
      chunks.push(c);
      offset += c.length;
    }
  }
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(ascii(xref));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Lay `copies` of each label out over sheet cells (or one roll page per copy). */
export function planPages(
  preset: LabelPreset,
  labels: Array<{ image: number; copies: number; widthMm: number; heightMm: number }>
): PdfPage[] {
  const pages: PdfPage[] = [];
  if (preset.kind === 'roll') {
    for (const l of labels)
      for (let c = 0; c < l.copies; c++)
        pages.push({
          widthMm: l.widthMm,
          heightMm: l.heightMm,
          placements: [{ image: l.image, xMm: 0, yMm: 0, wMm: l.widthMm, hMm: l.heightMm }],
        });
    return pages;
  }
  let index = 0;
  for (const l of labels)
    for (let c = 0; c < l.copies; c++) {
      const cell = sheetCell(preset, index++);
      while (pages.length <= cell.page)
        pages.push({ widthMm: A4_MM.w, heightMm: A4_MM.h, placements: [] });
      pages[cell.page].placements.push({
        image: l.image,
        xMm: cell.x,
        yMm: cell.y,
        wMm: l.widthMm,
        hMm: l.heightMm,
      });
    }
  return pages;
}
