/**
 * Product label layout (BARCODE-1): pure geometry in millimetres, shared by the admin preview,
 * the PNG/PDF renderer and the tests. A label is a name line, an optional variant line, a price,
 * the barcode with its digits, and an optional store QR. Anything that does not fit a small
 * label is dropped in a fixed order and reported in `dropped`, never squeezed unreadable.
 */
import { z } from 'zod/v3';
import { RECEIPT_BARCODE_SHAPES } from './shapes';
import { parseBarcodeInput } from './ean';
import { code128Modules } from './code128';
import { ean13Modules } from './ean';
import { BARCODE_PAD, BARCODE_QUIET } from './sizing';
import { barcodeShapeData } from './shapes';

export type LabelPreset = {
  id: string;
  kind: 'sheet' | 'roll';
  /** One label, mm. For a continuous roll `heightMm` is the label height we cut at. */
  widthMm: number;
  heightMm: number;
  /** Sheets only: A4 grid. */
  cols?: number;
  rows?: number;
  marginTopMm?: number;
  marginLeftMm?: number;
  gapXMm?: number;
  gapYMm?: number;
  /** Rolls only: the printable width of the head (58 mm paper prints 48 mm, 80 mm prints 72 mm). */
  printableWidthMm?: number;
  /** Continuous roll: the label is as tall as its content (`heightMm` is the minimum). */
  continuous?: boolean;
};

export const A4_MM = { w: 210, h: 297 } as const;

export const LABEL_PRESETS: readonly LabelPreset[] = [
  // Common Egyptian A4 sticker sheets (same cuts as the widely stocked 21 / 40 / 65-up sheets).
  {
    id: 'a4-3x7',
    kind: 'sheet',
    widthMm: 63.5,
    heightMm: 38.1,
    cols: 3,
    rows: 7,
    marginTopMm: 15.15,
    marginLeftMm: 7.2,
    gapXMm: 2.5,
    gapYMm: 0,
  },
  {
    id: 'a4-4x10',
    kind: 'sheet',
    widthMm: 45.7,
    heightMm: 25.4,
    cols: 4,
    rows: 10,
    marginTopMm: 21.5,
    marginLeftMm: 9.7,
    gapXMm: 2.8,
    gapYMm: 0,
  },
  {
    id: 'a4-5x13',
    kind: 'sheet',
    widthMm: 38.1,
    heightMm: 21.2,
    cols: 5,
    rows: 13,
    marginTopMm: 10.7,
    marginLeftMm: 4.7,
    gapXMm: 2.5,
    gapYMm: 0,
  },
  // Thermal rolls.
  {
    id: 'roll-58',
    kind: 'roll',
    widthMm: 58,
    heightMm: 40,
    printableWidthMm: 48,
    continuous: true,
  },
  {
    id: 'roll-80',
    kind: 'roll',
    widthMm: 80,
    heightMm: 40,
    printableWidthMm: 72,
    continuous: true,
  },
  { id: 'roll-40x30', kind: 'roll', widthMm: 40, heightMm: 30, printableWidthMm: 38 },
  { id: 'roll-50x25', kind: 'roll', widthMm: 50, heightMm: 25, printableWidthMm: 48 },
] as const;

export const LABEL_PRESET_IDS = LABEL_PRESETS.map(p => p.id) as [string, ...string[]];
export const labelPresetById = (id: string) => LABEL_PRESETS.find(p => p.id === id);

export const labelSettingsSchema = z
  .object({
    /** 'plain' (true EAN-13 / Code 128) or one of the 24 BARKOD shapes (always Code 128). */
    shape: z.enum(['plain', ...RECEIPT_BARCODE_SHAPES] as [string, ...string[]]),
    preset: z.enum(LABEL_PRESET_IDS),
    lang: z.enum(['ar', 'en']),
    content: z
      .object({
        name: z.boolean(),
        variant: z.boolean(),
        price: z.boolean(),
        digits: z.boolean(),
        qr: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type LabelSettings = z.infer<typeof labelSettingsSchema>;

export const DEFAULT_LABEL_SETTINGS: LabelSettings = {
  shape: 'plain',
  preset: 'a4-3x7',
  lang: 'ar',
  content: { name: true, variant: true, price: true, digits: true, qr: false },
};

export type LabelItem = {
  name: string;
  nameAr?: string | null;
  variantTitle?: string | null;
  variantTitleAr?: string | null;
  /** Piastres. */
  priceMinor: number;
  barcode: string;
  /** Product page on the store's own domain (custom domain when set, else <slug>.ebda.app). */
  qrUrl?: string | null;
};

export type LabelText = {
  role: 'name' | 'variant' | 'price' | 'digits';
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Font size in mm. */
  size: number;
  bold: boolean;
  rtl: boolean;
  align: 'start' | 'center';
};

export type LabelLayout = {
  widthMm: number;
  heightMm: number;
  texts: LabelText[];
  barcode: {
    x: number;
    y: number;
    w: number;
    h: number;
    value: string;
    /** What is encoded: EAN-13 for plain 13/12-digit codes, otherwise Code 128. */
    symbology: 'ean13' | 'code128';
    shape: string;
    /** Width of the narrowest bar on paper. */
    moduleMm: number;
    /** The drawn art inside the box (a shape keeps its aspect; plain bars fill the box). */
    art: { x: number; y: number; w: number; h: number };
  };
  /** `size` = the whole code incl. its quiet zone, mm; `moduleMm` = one QR dot on paper. */
  qr: { x: number; y: number; size: number; modules: number; moduleMm: number; url: string } | null;
  /** The QR was asked for but cannot be scanned at this label size: the label is refused (never silently squeezed). */
  qrRefused: boolean;
  /** Parts left out because they did not fit this label size. */
  dropped: Array<'qr' | 'variant' | 'price' | 'name' | 'digits'>;
  /** False when the narrowest bar would print under MIN_MODULE_MM: pick a bigger label or a plain EAN-13. */
  printable: boolean;
};

/** Smallest QR dot that scans reliably off a 203 dpi thermal head (2 dots) and a 300 dpi laser. */
// pq-allow(unused-export): asserted by tests/unit/barcode-labels.test.ts
export const MIN_QR_MODULE_MM = 0.25;
/** Quiet zone around the QR, in dots (same as the QR renderer's scene). */
// pq-allow(unused-export): asserted by tests/unit/barcode-labels.test.ts
export const QR_QUIET_MODULES = 4;
/** Byte-mode capacity at error correction M, QR versions 1..20 (ISO 18004 table 7). */
const QR_BYTES_M = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
];

/** Dots per side (without quiet zone) of the QR that encodes `url` at ECC M. */
// pq-allow(unused-export): asserted by tests/unit/barcode-labels.test.ts
export function qrModuleCount(url: string): number {
  const bytes = new TextEncoder().encode(url).length;
  const v = QR_BYTES_M.findIndex(c => bytes <= c) + 1;
  if (v === 0) throw new Error('qr url too long for a label');
  return 17 + 4 * v;
}

/** Narrowest bar a thermal head (203 dpi, ~0.125 mm/dot) prints reliably: 1.5 dots. */
export const MIN_MODULE_MM = 0.19;
const PAD = 1.5;

function priceText(minor: number, lang: 'ar' | 'en'): string {
  const v = (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);
  return lang === 'ar' ? `${v} ج.م` : `EGP ${v}`;
}

/** EAN-13 digits grouped as printed: 1 | 6 | 6. */
export function humanDigits(value: string): string {
  const p = parseBarcodeInput(value);
  if (p.ok && p.kind === 'ean13') return `${value[0]} ${value.slice(1, 7)} ${value.slice(7)}`;
  if (p.ok && p.kind === 'upca')
    return `${value[0]} ${value.slice(1, 6)} ${value.slice(6, 11)} ${value[11]}`;
  return value;
}

/** Modules incl. quiet zones for the symbology that will actually print. */
export function barcodeModuleCount(
  value: string,
  shape: string
): { symbology: 'ean13' | 'code128'; modules: number } {
  const p = parseBarcodeInput(value);
  if (shape === 'plain' && p.ok && (p.kind === 'ean13' || p.kind === 'upca')) {
    const v = p.kind === 'upca' ? `0${p.value}` : p.value;
    return { symbology: 'ean13', modules: ean13Modules(v).length + 11 + 7 };
  }
  return { symbology: 'code128', modules: code128Modules(value).length + BARCODE_QUIET * 2 };
}

export function layoutLabel(
  preset: LabelPreset,
  item: LabelItem,
  settings: Pick<LabelSettings, 'shape' | 'lang' | 'content'>
): LabelLayout {
  const W = preset.widthMm;
  const H = preset.heightMm;
  const printW = preset.printableWidthMm ?? W;
  const x0 = (W - printW) / 2 + PAD;
  const innerW = printW - 2 * PAD;
  const rtl = settings.lang === 'ar';
  const dropped: LabelLayout['dropped'] = [];

  const name = (settings.lang === 'ar' && item.nameAr ? item.nameAr : item.name).trim();
  const variantRaw =
    settings.lang === 'ar' && item.variantTitleAr ? item.variantTitleAr : item.variantTitle;
  const wants = {
    name: settings.content.name && !!name,
    variant: settings.content.variant && !!variantRaw,
    price: settings.content.price,
    digits: settings.content.digits,
    qr: settings.content.qr,
  };

  // Vertical budget: the barcode needs at least MIN_BAR_H; text lines are dropped from the bottom of the priority list.
  const MIN_BAR_H = Math.max(7, H * 0.28);
  const lineH = Math.max(2.4, Math.min(3.6, H * 0.12));
  const digitsH = 2.6;
  const priority: Array<'name' | 'price' | 'variant'> = ['name', 'price', 'variant'];
  const lines = { name: wants.name, variant: wants.variant, price: wants.price } as Record<
    string,
    boolean
  >;
  const used = () =>
    2 * PAD +
    MIN_BAR_H +
    (wants.digits ? digitsH : 0) +
    priority.filter(k => lines[k]).length * lineH;
  for (const k of [...priority].reverse()) {
    if (lines[k] && used() > H) {
      lines[k] = false;
      dropped.push(k);
    }
  }
  let digitsOn = wants.digits;
  if (digitsOn && used() > H) {
    digitsOn = false;
    dropped.push('digits');
  }

  // QR (combined barcode + QR label): top-right square at the largest size the label allows. It is
  // never shrunk below MIN_QR_MODULE_MM per dot: if the code, the text and the bars cannot all keep
  // their scannable size the label is refused (`qrRefused`) instead of printing a dead QR.
  let qr: LabelLayout['qr'] = null;
  let qrRefused = false;
  if (wants.qr && !item.qrUrl) dropped.push('qr');
  else if (wants.qr && item.qrUrl) {
    const modules = qrModuleCount(item.qrUrl);
    const total = modules + 2 * QR_QUIET_MODULES;
    const size = Math.min(H * 0.42, innerW * 0.3);
    const textsH = priority.filter(k => lines[k]).length * lineH;
    const barTop = PAD + Math.max(size + 1, textsH);
    const fits =
      size >= total * MIN_QR_MODULE_MM &&
      barTop + MIN_BAR_H + (digitsOn ? digitsH : 0) + PAD <= H + 1e-6;
    if (fits)
      qr = {
        x: rtl ? x0 : x0 + innerW - size,
        y: PAD,
        size,
        modules,
        moduleMm: size / total,
        url: item.qrUrl,
      };
    else qrRefused = true;
  }
  const textW = qr ? innerW - qr.size - 1.5 : innerW;
  const textX = qr && rtl ? x0 + qr.size + 1.5 : x0;

  const texts: LabelText[] = [];
  let y = PAD;
  const push = (role: LabelText['role'], text: string, bold: boolean, sizeMul = 0.78) => {
    texts.push({
      role,
      text,
      x: textX,
      y,
      w: textW,
      h: lineH,
      size: lineH * sizeMul,
      bold,
      rtl,
      align: 'start',
    });
    y += lineH;
  };
  if (lines.name) push('name', name, true);
  if (lines.variant) push('variant', variantRaw!.trim(), false, 0.7);
  if (lines.price) push('price', priceText(item.priceMinor, settings.lang), true, 0.85);
  // The QR sits beside the text block; the barcode starts below whichever is taller.
  if (qr) y = Math.max(y, PAD + qr.size + 1);

  const digitsReserve = digitsOn ? digitsH : 0;
  const { symbology, modules } = barcodeModuleCount(item.barcode, settings.shape);
  const shapeData = settings.shape === 'plain' ? undefined : barcodeShapeData(settings.shape);
  const aspect = shapeData ? (shapeData.h + 2 * BARCODE_PAD) / (shapeData.w + 2 * BARCODE_PAD) : 0;
  const available = Math.max(MIN_BAR_H, H - PAD - y - digitsReserve);
  // A shape needs height proportional to its width: a continuous roll grows to fit it, a fixed
  // label scales the shape down (and the self-check / `printable` then decide whether it still scans).
  const barH = shapeData && preset.continuous ? innerW * aspect : available;
  const artW = shapeData ? Math.min(innerW, barH / aspect) : innerW;
  const artH = shapeData ? artW * aspect : barH;
  const moduleMm = shapeData
    ? (artW * (shapeData.w / (shapeData.w + 2 * BARCODE_PAD))) / modules
    : innerW / modules;
  const barcode = {
    x: x0,
    y,
    w: innerW,
    h: barH,
    value: item.barcode,
    symbology,
    shape: settings.shape,
    moduleMm,
    art: { x: x0 + (innerW - artW) / 2, y, w: artW, h: artH },
  };
  y += barH;
  if (digitsOn) {
    texts.push({
      role: 'digits',
      text: humanDigits(item.barcode),
      x: x0,
      y,
      w: innerW,
      h: digitsH,
      size: digitsH * 0.85,
      bold: false,
      rtl: false,
      align: 'center',
    });
    y += digitsH;
  }
  const finalH = preset.continuous ? Math.max(H, y + PAD) : H;

  return {
    widthMm: W,
    heightMm: finalH,
    texts,
    barcode,
    qr,
    qrRefused,
    dropped,
    printable: moduleMm >= MIN_MODULE_MM && barH >= 5 && !qrRefused,
  };
}

/** Left/top of cell `index` (0-based, row-major) on an A4 sheet preset, mm. */
export function sheetCell(
  preset: LabelPreset,
  index: number
): { page: number; x: number; y: number } {
  if (preset.kind !== 'sheet') throw new Error('sheetCell: not a sheet preset');
  const per = preset.cols! * preset.rows!;
  const page = Math.floor(index / per);
  const i = index % per;
  const col = i % preset.cols!;
  const row = Math.floor(i / preset.cols!);
  return {
    page,
    x: preset.marginLeftMm! + col * (preset.widthMm + preset.gapXMm!),
    y: preset.marginTopMm! + row * (preset.heightMm + preset.gapYMm!),
  };
}
